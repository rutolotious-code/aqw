import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import {
  View,
  Text,
  Alert,
  AppState,
  BackHandler,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
  Platform,
  Animated,
} from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import ReanimatedAnimated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { database, auth, firestore } from '@/config/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';

// Helper functions to handle location across platforms
const getLocation = async () => {
  if (Platform.OS !== 'web') {
    const Location = await import('expo-location');
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      const location = await Location.getCurrentPositionAsync({});
      return location.coords;
    }
    console.log('[v0] getLocation: foreground location permission not granted, status =', status);
    return null;
  } else {
    return new Promise<{ latitude: number; longitude: number; heading?: number } | null>((resolve) => {
      if (!navigator.geolocation) {
        console.log('[v0] getLocation: navigator.geolocation is unavailable');
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, heading: pos.coords.heading || 0 }),
        (error) => {
          console.log('[v0] getLocation: getCurrentPosition failed:', error.message);
          resolve(null);
        }
      );
    });
  }
};

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

const watchLocation = async (callback: (coords: { latitude: number; longitude: number; heading: number; speed: number; accuracy: number }) => void) => {
  if (isNative()) {
    const id = await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: 'Tracking your location while you are online',
        backgroundTitle: 'Aletwende Driver',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10,
      },
      (location, error) => {
        if (error) {
          console.log('[v0] Background location error:', error.message);
          return;
        }
        if (!location) return;
        callback({
          latitude: location.latitude,
          longitude: location.longitude,
          heading: location.bearing ?? 0,
          speed: location.speed ?? 0,
          accuracy: location.accuracy ?? Infinity,
        });
      }
    );
    return { remove: () => BackgroundGeolocation.removeWatcher({ id }) };
  }

  if (Platform.OS !== 'web') {
    const Location = await import('expo-location');
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.log('[v0] Location permission denied');
      return null;
    }

    return await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 3000,
        distanceInterval: 15,
      },
      (loc) => {
        callback({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          heading: loc.coords.heading || 0,
          speed: loc.coords.speed || 0,
          accuracy: loc.coords.accuracy ?? Infinity,
        });
      }
    );
  }

  if (!navigator.geolocation) return null;
  const watchId = navigator.geolocation.watchPosition(
    (pos) => callback({
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      heading: pos.coords.heading || 0,
      speed: pos.coords.speed || 0,
      accuracy: pos.coords.accuracy ?? Infinity,
    }),
    (error) => {
      console.log('[v0] Location error:', error.message);
    },
    { enableHighAccuracy: true }
  );
  return { remove: () => navigator.geolocation.clearWatch(watchId) };
};
import { ref, update, onValue, off, remove, set } from 'firebase/database';
import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { isNative } from '@/utils/nativeCalls';
import { clearDriverPresence } from '@/utils/driverPresence';
import { Home, Mail, Clock, Settings, Phone } from 'lucide-react-native';
import { useCall } from '@/context/CallContext';
import ChatPanel from '@/components/ChatPanel';
import InboxPanel from '@/components/InboxPanel';
import ToastNotification from '@/components/ToastNotification';
import DriverMap from '@/components/DriverMap';
import { useActiveTrip } from '@/hooks/useActiveTrip';
import { useTripRequest } from '@/context/IncomingRidesContext';
import { isStoreWorkflow } from '@/utils/workflow';
import { useAudioPlayer } from 'expo-audio';
import messageSound from '@/assets/sounds/message.mp3';
import { createGeoFireObject } from '@/utils/geofire';
import { distanceMeters, bearingDegrees } from '@/utils/geo';
import { set as setLocation } from '@/utils/locationStore';
import { getUnreadCount, listenForClientMessages, autoDeleteReadMessages, watchRideStatusForCleanup } from '@/utils/chat';
import TripsHistory from '@/components/TripsHistory';
import { useDriverTripHistory } from '@/hooks/useDriverTripHistory';
import DriverSettings from '@/components/DriverSettings';
import BottomNav from '@/components/BottomNav';

const { width, height } = Dimensions.get('window');

export default function Dashboard() {
  const router = useRouter();
  const [isOnline, setIsOnline] = useState(false);
  const [isPresenceLoaded, setIsPresenceLoaded] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [userStatus, setUserStatus] = useState<'pending' | 'approved' | 'accepted' | 'rejected'>('pending');
  const [registrationCompleted, setRegistrationCompleted] = useState(false);
  const [locationSubscription, setLocationSubscription] = useState<any>(null);
  const locationSubscriptionRef = useRef<any>(null);
  const trackingStartRef = useRef<Promise<void> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestLocationRef = useRef<{ latitude: number; longitude: number; heading: number } | null>(null);
  const trackingUidRef = useRef<string | null>(null);
  const stopTrackingRef = useRef<(() => Promise<void>) | null>(null);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('home');

  // Active ride state for location updates (trip managed by GlobalTripRequestPanel)
  const [rtdbActive, setRtdbActive] = useState<{ orderId: string; status: string } | null>(null);
  const activeRideIdRef = useRef<string | null>(null);
  const activeRideStatusRef = useRef<string | null>(null);
  const [driverData, setDriverData] = useState<any>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [vehicleType, setVehicleType] = useState<string>('economy');
  const [vehicleColor, setVehicleColor] = useState<string>('b');
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [vehiclePosition, setVehiclePosition] = useState<{ lat: number; lng: number; heading: number } | null>(null);
  const stableHeadingRef = useRef(0);
  const lastAcceptedPositionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const lastLocationWriteRef = useRef(0);
  const sessionIdRef = useRef(`session-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        onlineRef.current = false;
        setIsOnline(false);
        void stopTrackingRef.current?.();
        router.replace('/');
      }
    });
    return unsubscribe;
  }, [router]);

  // Active trip from Firestore orders (drives the live map polylines + markers)
  const { activeOrder, pendingEarnings } = useTripRequest();
  const effectiveRideId = rtdbActive?.orderId ?? activeOrder?.orderId ?? null;
  const effectiveRideStatus = rtdbActive?.status ?? activeOrder?.uiStatus ?? activeOrder?.status ?? null;
  activeRideIdRef.current = effectiveRideId;
  activeRideStatusRef.current = effectiveRideStatus;
  const { activeTrip, liveOrder, driverStatus, storeCallable, tripStatus, workflowType, markers, activePolyline, showPolyline, arrivalTime } =
  useActiveTrip(driverId, activeOrder);
  const { callState, formattedTime, startCall } = useCall();
  const { totalEarnings, loading: tripHistoryLoading } = useDriverTripHistory(driverId, 'today');

  const callPulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (callState !== 'calling') {
      callPulse.stopAnimation();
      callPulse.setValue(1);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(callPulse, { toValue: 0.35, duration: 650, useNativeDriver: true }),
      Animated.timing(callPulse, { toValue: 1, duration: 650, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [callPulse, callState]);

  // Arrival card anchors at the coordinate matching the current trip phase:
  //   direct_trip accepted -> pickup, store_delivery accepted -> store,
  //   started / picked_up -> destination (dropoff), otherwise none.
  let arrivalPosition: { lat: number; lng: number } | null = null;
  let arrivalTargetId: string | null = null;
  if (arrivalTime && tripStatus && workflowType) {
    if (workflowType === 'direct_trip') {
      if (tripStatus === 'accepted') arrivalTargetId = 'pickup';
      else if (tripStatus === 'started') arrivalTargetId = 'dropoff';
    } else if (isStoreWorkflow(workflowType)) {
      if (tripStatus === 'accepted') arrivalTargetId = 'store';
      else if (tripStatus === 'picked_up') arrivalTargetId = 'dropoff';
    }
    if (arrivalTargetId) {
      const target = markers.find((m) => m.id === arrivalTargetId);
      if (target) arrivalPosition = { lat: target.lat, lng: target.lng };
      else arrivalTargetId = null; // no matching marker, nothing to hide
    }
  }

  // Hide the plain dot/pin marker that sits directly under the arrival pill so
  // it doesn't read as a spade/shield beneath the "Arrive by ..." card. Other
  // markers along the route still render normally.
  const displayedMarkers =
    arrivalPosition && arrivalTargetId
      ? markers.filter((m) => m.id !== arrivalTargetId)
      : markers;

  const [showChatPanel, setShowChatPanel] = useState(false);
  const showChatPanelRef = useRef(showChatPanel);
  const [showInboxPanel, setShowInboxPanel] = useState(false);
  // A trip is active whenever there is a non-terminal trip status. When active
  // the map shows the whole route radius (FIT_BOUNDS) and disables the idle
  // auto-recenter; when inactive the map centers on the vehicle on load and
  // auto-recenters after 20s of no interaction. The user can always zoom freely.
  const hasActiveTrip = !!tripStatus;
  const backPressRef = useRef(0);
  const hasPendingEarnings = pendingEarnings.length > 0;
  const dashboardStateRef = useRef({ activeTab, showChatPanel, showInboxPanel, hasActiveTrip, isOnline, hasPendingEarnings });
  const [unreadCount, setUnreadCount] = useState(0);
  const [showToast, setShowToast] = useState(false);
  const [toastData, setToastData] = useState({ clientName: '', message: '' });
  const [chatRideInfo, setChatRideInfo] = useState<any>(null);
  const messagePlayer = useAudioPlayer(messageSound);

  useEffect(() => {
    showChatPanelRef.current = showChatPanel;
  }, [showChatPanel]);

  useEffect(() => {
    dashboardStateRef.current = { activeTab, showChatPanel, showInboxPanel, hasActiveTrip, isOnline, hasPendingEarnings };
  }, [activeTab, showChatPanel, showInboxPanel, hasActiveTrip, isOnline, hasPendingEarnings]);

  useEffect(() => {
    const handleBack = () => {
      const state = dashboardStateRef.current;
      if (state.showChatPanel || state.showInboxPanel) {
        setShowChatPanel(false);
        setShowInboxPanel(false);
        return true;
      }
      if (state.hasPendingEarnings) {
        setToastData({ clientName: 'Notice', message: 'Tap Done on your trip summary first.' });
        setShowToast(true);
        return true;
      }
      if (state.activeTab !== 'home') {
        setActiveTab('home');
        return true;
      }
      if (state.hasActiveTrip) {
        setToastData({ clientName: 'Notice', message: "Finish your trip first. You can't leave while a trip is active." });
        setShowToast(true);
        return true;
      }
      if (state.isOnline) {
        const now = Date.now();
        if (now - backPressRef.current < 2000) {
          if (Platform.OS !== 'web') BackHandler.exitApp();
        } else {
          backPressRef.current = now;
          setToastData({ clientName: 'Notice', message: 'Press back again to exit' });
          setShowToast(true);
        }
        return true;
      }
      return false;
    };

    if (Platform.OS === 'web') {
      window.history.pushState({ dashboardGuard: true }, '', window.location.href);
      const onPopState = () => {
        if (handleBack()) window.history.pushState({ dashboardGuard: true }, '', window.location.href);
      };
      window.addEventListener('popstate', onPopState);
      return () => window.removeEventListener('popstate', onPopState);
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => subscription.remove();
  }, []);

  const sliderX = useSharedValue(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const THUMB_SIZE = 48;
  const SLIDE_RANGE = Math.max(0, trackWidth - THUMB_SIZE - 8);
  const SLIDE_THRESHOLD = SLIDE_RANGE * 0.6;
  const onlineRef = useRef(false);
  const isDraggingRef = useRef(false);
  const localTransitionRef = useRef(false);
  const localChangeUntilRef = useRef(0);
  const sliderHasLaidOutRef = useRef(false);
  const sliderStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: sliderX.value }],
  }));
  const animateSlider = (online: boolean) => {
    sliderX.value = withSpring(online ? SLIDE_RANGE : 0);
  };

  // Panel animation for draggable bottom sheet (panel slides behind nav bar)
  // Collapsed: panel slides down so only scheduled card is visible above nav (85px)
  // Expanded: shows all content including toggle
  const PANEL_TOTAL_HEIGHT = 380; // Total panel height
  const NAV_HEIGHT = 85;
  // When collapsed, panel should hide behind nav, only showing scheduled card (~100px visible)
  const PANEL_COLLAPSED_OFFSET = PANEL_TOTAL_HEIGHT - NAV_HEIGHT - 100; // How much to push down when collapsed
  const PANEL_EXPANDED_OFFSET = 0; // When expanded, no offset
  const panelY = useRef(new Animated.Value(PANEL_COLLAPSED_OFFSET)).current; // Start collapsed
  const savedPanelY = useRef(PANEL_COLLAPSED_OFFSET);
  // Single source of truth for the panel's true current Y, kept in sync via the
  // supported public listener API. Reading panelY._value directly is unreliable
  // with useNativeDriver (the JS value lags the native thread), which caused the
  // drag to snap from a stale baseline instead of following the finger.
  const panelYRef = useRef(PANEL_COLLAPSED_OFFSET);

  // Dashboard entry animations
  const panelSlideAnim = useRef(new Animated.Value(300)).current; // Panel slides up from bottom
  const cardsFadeAnim = useRef(new Animated.Value(0)).current; // Cards fade in
  const cardsScaleAnim = useRef(new Animated.Value(0.95)).current; // Cards scale up

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      setIsLoading(false);
      return;
    }
    setDriverId(uid);
    // LISTEN TO FIRESTORE drivers/{uid} for verification status (NOT Realtime DB users/{uid})
    const driverDocRef = doc(firestore, 'drivers', uid);
    const unsubscribeFirestore = onSnapshot(driverDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        // Set verification status from Firestore
        const verificationStatus = data.verificationStatus || 'pending';
        const regCompleted = data.registrationCompleted === true;

        setUserStatus(verificationStatus as 'pending' | 'approved' | 'accepted' | 'rejected');
        setRegistrationCompleted(regCompleted);

        // Store driver profile data for ride acceptance - include ALL fields
        setDriverData({
          profile: {
            // Registration stores names under `profile`; keep top-level fallbacks
            // for older driver documents created before that structure existed.
            firstName: data.profile?.firstName || data.firstName || '',
            lastName: data.profile?.lastName || data.lastName || '',
            profilePicture: data.profile?.profilePicture || data.profilePicture || '',
          },
          vehicle: {
            brand: data.vehicleBrand || '',
            model: data.vehicleModel || '',
            color: data.vehicleColor || '',
            plateNumber: data.plateNumber || '',
            // Truck-specific fields
            tonnage: data.tonnage || '',
            refrigerationType: data.refrigerationType || '',
          },
          rating: data.rating || 5.0,
          activityScore: data.activityScore ?? null,
        });

        // Determine vehicle type for the map vehicle marker
        const resolvedVehicleType =
          data.vehicle?.type || data.vehicleType ||
          data.serviceType ||
          data.category ||
          'economy';
        setVehicleType(String(resolvedVehicleType).toLowerCase());
        const rawColor = String(data.vehicle?.color || data.vehicleColor || 'black').toLowerCase();
        setVehicleColor(({black:'b',blue:'bl',red:'r',gray:'g',grey:'g',white:'w'} as any)[rawColor] || rawColor);
      }
      setIsLoading(false);
    });

    // Listen to drivers_online/{uid} for online status
    const driversOnlineRef = ref(database, `drivers_online/${uid}`);
    const onlineListener = onValue(driversOnlineRef, (snapshot) => {
      const data = snapshot.val();
      const nextOnline = data?.isOnline === true;
      setIsOnline(nextOnline);
      setIsBusy(data?.isBusy === true);
      onlineRef.current = nextOnline;
      if (data?.sessionId && data.sessionId !== sessionIdRef.current && nextOnline) {
        setIsOnline(false);
        onlineRef.current = false;
      }
      setIsPresenceLoaded(true);
    });

    // Listen for active trip status changes (for location updates and chat)
    const tripRequestsRef = ref(database, `driver_trip_requests/${uid}`);
    const tripRequestsListener = onValue(tripRequestsRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const requests = Object.values(data) as any[];
        const activeRequest = requests.find(r => 
          !['completed', 'rejected', 'expired', 'cancelled'].includes(r.status)
        );
        if (activeRequest) {
          setRtdbActive({ orderId: activeRequest.orderId, status: activeRequest.status });
          setChatRideInfo({
            id: activeRequest.orderId,
            clientName: activeRequest.data?.userName || 'Client',
            clientId: activeRequest.data?.userId || '',
            pickupAddress: activeRequest.data?.pickupAddress || '',
            destinationAddress: activeRequest.data?.destinationAddress || '',
            status: activeRequest.status,
          });
        } else {
          setRtdbActive(null);
          setChatRideInfo(null);
          setUnreadCount(0);
        }
      } else {
        setRtdbActive(null);
        setChatRideInfo(null);
        setUnreadCount(0);
      }
    });

    return () => {
      unsubscribeFirestore();
      off(driversOnlineRef, 'value', onlineListener);
      off(tripRequestsRef, 'value', tripRequestsListener);
    };
  }, []);

  useEffect(() => {
    if (
      trackWidth <= 0 ||
      isDraggingRef.current ||
      localTransitionRef.current ||
      Date.now() < localChangeUntilRef.current
    ) {
      return;
    }

    const target = isOnline ? SLIDE_RANGE : 0;
    if (!sliderHasLaidOutRef.current) {
      sliderX.value = target;
      sliderHasLaidOutRef.current = true;
      return;
    }

    sliderX.value = withSpring(target);
  }, [trackWidth, isOnline]);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid || userStatus !== 'approved' || !effectiveRideId) {
      setUnreadCount(0);
      return;
    }

    const rideId = effectiveRideId;
    const clientId = chatRideInfo?.clientId || '';
    let subscriptionActive = true;

    console.log('[chat] subscribing to active ride', { rideId, driverId: uid });
    const unsubscribeUnread = getUnreadCount(database, rideId, uid, (count) => {
      console.log('[chat] unread count update', { rideId, count });
      setUnreadCount(count);
    });

    const unsubscribeMessages = listenForClientMessages(
      database,
      rideId,
      uid,
      (message, messageId) => {
        console.log('[chat] client message received', { rideId, messageId, senderId: message.senderId });
        if (subscriptionActive && message.senderId !== uid && !showChatPanelRef.current) {
          if (Platform.OS !== 'web') {
            try {
              messagePlayer.seekTo(0);
              Promise.resolve(messagePlayer.play()).catch((error) => {
                if (subscriptionActive) {
                  console.log('[v0] Message alert playback failed:', error);
                }
              });
            } catch (error) {
              if (subscriptionActive) {
                console.log('[v0] Message alert playback failed:', error);
              }
            }
          }
          const clientName = chatRideInfo?.clientName || 'Client';
          setToastData({
            clientName,
            message: message.text,
          });
          setShowToast(true);
        }
      }
    );

    const unsubscribeAutoDelete = autoDeleteReadMessages(database, rideId, clientId, uid);
    const unsubscribeCleanup = watchRideStatusForCleanup(database, rideId, uid, {
      clientName: chatRideInfo?.clientName || 'Client',
      pickupAddress: chatRideInfo?.pickupAddress || '',
      destinationAddress: chatRideInfo?.destinationAddress || '',
    });

    return () => {
      subscriptionActive = false;
      unsubscribeUnread();
      unsubscribeMessages();
      unsubscribeAutoDelete();
      unsubscribeCleanup();
    };
  }, [effectiveRideId, chatRideInfo, messagePlayer, userStatus]);

  const handleInboxPress = () => {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      return;
    }

    setActiveTab('inbox');

    // If there's an active trip we can chat in, open the live chat panel.
    const validStatuses = ['accepted', 'arrived', 'started', 'at_store', 'picked_up', 'delivered'];
    if (effectiveRideId && effectiveRideStatus && validStatuses.includes(effectiveRideStatus)) {
      setUnreadCount(0);
      setShowChatPanel(true);
      return;
    }

    // Otherwise open the Inbox so the driver can view past conversations.
    setShowInboxPanel(true);
  };

  const writeDriverLocation = async (uid: string, latitude: number, longitude: number) => {
    const geoObject = createGeoFireObject(latitude, longitude);
    await set(ref(database, `driver_locations/${uid}`), {
      l: geoObject.l,
      g: geoObject.g,
      t: Date.now(),
      sessionId: sessionIdRef.current,
    });
  };

  const startLocationHeartbeat = (uid: string) => {
    if (heartbeatIntervalRef.current || !onlineRef.current) return;
    heartbeatIntervalRef.current = setInterval(() => {
      const latest = latestLocationRef.current;
      if (!onlineRef.current || !latest) return;
      void writeDriverLocation(uid, latest.latitude, latest.longitude).catch((error) => {
        console.log('[v0] Location heartbeat write failed:', error);
      });
    }, 10_000);
  };

  const startTracking = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid || !onlineRef.current) return;
    if (locationSubscriptionRef.current) {
      trackingUidRef.current = uid;
      startLocationHeartbeat(uid);
      return;
    }
    if (trackingStartRef.current) return trackingStartRef.current;

    trackingStartRef.current = (async () => {
      console.log('[v0] Starting location tracking for driver:', uid);
      setLocationPermissionDenied(false);

      const subscription = await watchLocation(async (coords) => {
        const { latitude, longitude, heading, speed, accuracy } = coords;
        if (!Number.isFinite(accuracy) || accuracy > 50) return;
        const previous = lastAcceptedPositionRef.current;
        const distance = previous
          ? distanceMeters(previous.latitude, previous.longitude, latitude, longitude)
          : 0;
        let nextHeading = stableHeadingRef.current;
        if (previous && distance >= 5) {
          const bearing = bearingDegrees(previous.latitude, previous.longitude, latitude, longitude);
          const headingDelta = Math.abs(((bearing - stableHeadingRef.current + 540) % 360) - 180);
          if (headingDelta <= 120 || distance >= 15) nextHeading = bearing;
        } else if (Number.isFinite(heading) && heading >= 0 && speed > 1.5) {
          const headingDelta = Math.abs(((heading - stableHeadingRef.current + 540) % 360) - 180);
          if (headingDelta <= 120 || distance >= 15) nextHeading = heading;
        }
        if (distance >= 5) lastAcceptedPositionRef.current = { latitude, longitude };
        stableHeadingRef.current = nextHeading;
        latestLocationRef.current = { latitude, longitude, heading: stableHeadingRef.current };

        setCurrentLocation({ latitude, longitude });
        setLocationPermissionDenied(false);
        setVehiclePosition({ lat: latitude, lng: longitude, heading: stableHeadingRef.current });
        setLocation(latitude, longitude, stableHeadingRef.current, Date.now());

        if (Date.now() - lastLocationWriteRef.current >= 3000) {
          lastLocationWriteRef.current = Date.now();
          await writeDriverLocation(uid, latitude, longitude);
        }

        const rideId = activeRideIdRef.current;
        const rideStatus = activeRideStatusRef.current;
        if (rideId && rideStatus && ['accepted', 'arrived', 'started', 'at_store', 'picked_up'].includes(rideStatus)) {
          try {
            const orderRef = doc(firestore, 'orders', rideId);
            await updateDoc(orderRef, {
              driverLocation: { latitude, longitude, updatedAt: Date.now() },
            });
          } catch (error) {
            // Silently fail location updates to avoid spamming console
          }
        }
      });

      if (!subscription) {
        setLocationPermissionDenied(true);
        return;
      }
      trackingUidRef.current = uid;
      locationSubscriptionRef.current = subscription;
      setLocationSubscription(subscription);
      startLocationHeartbeat(uid);
    })();

    try {
      await trackingStartRef.current;
    } finally {
      trackingStartRef.current = null;
    }
  };

  const stopTracking = async () => {
    const uid = auth.currentUser?.uid ?? trackingUidRef.current;
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    const subscription = locationSubscriptionRef.current;
    locationSubscriptionRef.current = null;
    setLocationSubscription(null);

    if (subscription) {
      try {
        await subscription.remove();
      } catch (error) {
        console.log('[v0] Error removing location subscription:', error);
      }
    }

    trackingUidRef.current = null;
    latestLocationRef.current = null;
    if (uid) {
      try {
        await remove(ref(database, `driver_locations/${uid}`));
      } catch (error) {
        console.log('[v0] Error removing driver location:', error);
      }
    }
  };

  stopTrackingRef.current = stopTracking;

  useEffect(() => {
    if (!auth.currentUser?.uid || userStatus !== 'approved' || !isOnline) {
      if (!isOnline && isPresenceLoaded) void stopTracking();
      return;
    }

    let cancelled = false;
    const seedAndStart = async () => {
      if (locationSubscriptionRef.current || trackingStartRef.current || cancelled) return;
      if (Platform.OS !== 'web') {
        try {
          const Location = await import('expo-location');
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status !== 'granted') {
            setLocationPermissionDenied(true);
            return;
          }
          const lastKnown = await Location.getLastKnownPositionAsync({});
          const position = lastKnown || await Location.getCurrentPositionAsync({});
          if (!cancelled && position) {
            const { latitude, longitude } = position.coords;
            const heading = position.coords.heading || 0;
            latestLocationRef.current = { latitude, longitude, heading };
            setCurrentLocation({ latitude, longitude });
            setVehiclePosition({ lat: latitude, lng: longitude, heading });
          }
        } catch (error) {
          setLocationPermissionDenied(true);
        }
      } else {
        const position = await getLocation();
        if (!cancelled && position) {
          const heading = position.heading || 0;
          latestLocationRef.current = { latitude: position.latitude, longitude: position.longitude, heading };
          setCurrentLocation({ latitude: position.latitude, longitude: position.longitude });
          setVehiclePosition({ lat: position.latitude, lng: position.longitude, heading });
        }
      }
      if (!cancelled && isOnline) await startTracking();
    };

    void seedAndStart();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void seedAndStart();
    });
    return () => {
      cancelled = true;
      appStateSubscription.remove();
    };
  }, [isOnline, isPresenceLoaded, userStatus]);

  useEffect(() => () => {
    void stopTracking();
  }, []);

  const goOnline = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid || !driverData) return;

    const firstName = driverData.profile?.firstName || '';
    const lastName = driverData.profile?.lastName || '';
    const driverName = `${firstName} ${lastName}`.trim();

    const carBrand = driverData.vehicle?.brand || '';
    const carModelName = driverData.vehicle?.model || '';
    const carColor = driverData.vehicle?.color || '';
    const carModel = carColor && carBrand
      ? `${carColor} • ${carBrand} ${carModelName}`.trim()
      : `${carBrand} ${carModelName}`.trim();

    const plateNumber = driverData.vehicle?.plateNumber || '';
    const photo = driverData.profile?.profilePicture || '';
    const rating = driverData.rating || 5.0;

    let coords = await getLocation();

    // Fallback: a fresh GPS fix can be slow or time out. On native, fall back to
    // the last-known position so the vehicle marker appears immediately.
    if (!coords && Platform.OS !== 'web') {
      try {
        const Location = await import('expo-location');
        const lastKnown = await Location.getLastKnownPositionAsync({});
        if (lastKnown) {
          coords = lastKnown.coords;
          console.log('[v0] goOnline: using last-known position as fallback');
        } else {
          console.log('[v0] goOnline: no last-known position available');
        }
      } catch (err) {
        console.log('[v0] goOnline: getLastKnownPositionAsync failed:', err);
      }
    }

    if (coords) {
      const { latitude, longitude } = coords;
      const heading = (coords as any).heading || 0;
      latestLocationRef.current = { latitude, longitude, heading };
      setCurrentLocation({ latitude, longitude });
      setVehiclePosition({ lat: latitude, lng: longitude, heading });
      // Update driver_locations/{uid} with GeoFire format
      const geoObject = createGeoFireObject(latitude, longitude);
      await set(ref(database, `driver_locations/${uid}`), {
        l: geoObject.l,
        g: geoObject.g,
        t: Date.now(),
      });

      console.log('[v0] Driver went online, location set to driver_locations:', { lat: latitude, lng: longitude, g: geoObject.g });
    }

    // SET drivers_online/{uid} - NEW REALTIME STATE SYSTEM
    await set(ref(database, `drivers_online/${uid}`), {
      isOnline: true,
      isBusy: false,
      lastUpdated: Date.now(),
      sessionId: sessionIdRef.current,
    });

    setIsOnline(true);
    onlineRef.current = true;
    await startTracking();
    return true;
  };

  const goOffline = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    setIsOnline(false);
    onlineRef.current = false;
    await stopTracking();
    await clearDriverPresence(uid);
    return true;
  };

  // All trip lifecycle handling is now done via GlobalTripRequestPanel
  // which listens to RTDB driver_trip_requests/{uid} and calls backend APIs

  const startX = useRef(0);
  const savedTranslateX = useRef(0);

  const handleToggleEnd = async (nextOnline: boolean) => {
    isDraggingRef.current = false;
    if (nextOnline === onlineRef.current) {
      animateSlider(onlineRef.current);
      return;
    }
    if (!nextOnline && (isBusy || hasActiveTrip)) {
      setToastData({ clientName: 'Notice', message: 'Finish your trip first' });
      setShowToast(true);
      animateSlider(onlineRef.current);
      return;
    }
    localTransitionRef.current = true;
    localChangeUntilRef.current = Date.now() + 1500;
    try {
      if (nextOnline) await goOnline();
      else await goOffline();
    } catch (error) {
      console.log('[v0] Toggle transition failed:', error);
      setToastData({ clientName: 'Notice', message: 'Unable to change your online status' });
      setShowToast(true);
      onlineRef.current = false;
      setIsOnline(false);
    } finally {
      localTransitionRef.current = false;
      animateSlider(onlineRef.current);
    }
  };

  const gesture = Gesture.Pan()
    .runOnJS(true)
    .enabled(userStatus === 'approved' && registrationCompleted)
    .activeOffsetX([-10, 10])
    .failOffsetY([-15, 15])
    .onStart(() => {
      isDraggingRef.current = true;
      savedTranslateX.current = onlineRef.current ? SLIDE_RANGE : 0;
    })
    .onUpdate((event) => {
      sliderX.value = Math.max(0, Math.min(savedTranslateX.current + event.translationX, SLIDE_RANGE));
    })
    .onEnd((event, success) => {
      if (!success) {
        animateSlider(onlineRef.current);
        isDraggingRef.current = false;
        return;
      }
      const finalPosition = Math.max(0, Math.min(SLIDE_RANGE, savedTranslateX.current + event.translationX + event.velocityX * 0.1));
      handleToggleEnd(finalPosition >= SLIDE_THRESHOLD);
    });

  // Panel drag gesture for bottom sheet
  const panelGesture = Gesture.Pan()
    .onStart(() => {
      savedPanelY.current = panelYRef.current;
    })
    .onUpdate((event) => {
      // Allow dragging from collapsed (positive offset) to expanded (0)
      const newValue = Math.max(PANEL_EXPANDED_OFFSET, Math.min(PANEL_COLLAPSED_OFFSET, savedPanelY.current + event.translationY));
      panelY.setValue(newValue);
    })
    .onEnd((event) => {
      const snapThreshold = PANEL_COLLAPSED_OFFSET / 2;
      const currentValue = savedPanelY.current + event.translationY;

      if (currentValue < snapThreshold) {
        // Snap to expanded (fully visible)
        Animated.spring(panelY, {
          toValue: PANEL_EXPANDED_OFFSET,
          useNativeDriver: true,
          tension: 80,
          friction: 12,
        }).start(() => {
          savedPanelY.current = PANEL_EXPANDED_OFFSET;
        });
      } else {
        // Snap to collapsed (behind nav, only scheduled card visible)
        Animated.spring(panelY, {
          toValue: PANEL_COLLAPSED_OFFSET,
          useNativeDriver: true,
          tension: 80,
          friction: 12,
        }).start(() => {
          savedPanelY.current = PANEL_COLLAPSED_OFFSET;
        });
      }
    });

  // Keep panelYRef synced with the real animated value via the public API.
  useEffect(() => {
    const id = panelY.addListener((state) => {
      panelYRef.current = state.value;
    });
    return () => {
      panelY.removeListener(id);
    };
  }, [panelY]);

  useEffect(() => {
    return () => {
      if (locationSubscription) {
        (async () => {
          try {
            await locationSubscription.remove();
          } catch (error) {
            console.log('Error removing location subscription on cleanup:', error);
          }
        })();
      }
    };
  }, [locationSubscription]);

  // Dashboard entry animations - panel slides up to reveal toggle
  useEffect(() => {
    if (!isLoading) {
      // Animate panel sliding up from bottom
      Animated.spring(panelSlideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 50,
        friction: 10,
      }).start();

      // Animate cards fading in and scaling
      Animated.parallel([
        Animated.timing(cardsFadeAnim, {
          toValue: 1,
          duration: 400,
          delay: 200,
          useNativeDriver: true,
        }),
        Animated.spring(cardsScaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          tension: 60,
          friction: 8,
        }),
      ]).start();

      // After initial animation, smoothly expand panel to show toggle
      setTimeout(() => {
        Animated.spring(panelY, {
          toValue: PANEL_EXPANDED_OFFSET,
          useNativeDriver: true,
          tension: 60,
          friction: 12,
        }).start(() => {
          savedPanelY.current = PANEL_EXPANDED_OFFSET;
        });
      }, 600);
    }
  }, [isLoading]);

  if (isLoading) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="large" color="#006400" />
      </View>
    );
  }

if (activeTab === 'trips') {
  return <View style={styles.container}><TripsHistory driverId={driverId} /><BottomNav activeTab="trips" onChange={(tab) => setActiveTab(tab)} onInboxPress={handleInboxPress} unreadCount={unreadCount} /></View>;
  }
  
if (activeTab === 'settings') {
  return <View style={styles.container}><DriverSettings driverData={driverData} hasActiveTrip={hasActiveTrip} beforeLogout={async () => { await stopTracking(); if (driverId) await clearDriverPresence(driverId); }} onNavigate={(route) => {
  if (route === 'Vehicle and Documents') router.push('/vehicle-information');
  else if (route.toLowerCase() === 'security') router.push('/forgot-password');
  else Alert.alert(route, 'This section is coming soon.');
  }} /><BottomNav activeTab="settings" onChange={(tab) => setActiveTab(tab)} onInboxPress={handleInboxPress} unreadCount={unreadCount} /></View>;
  }

  return (
    <View style={styles.container}>
      {/* Trip request handling is now done globally via GlobalTripRequestPanel in _layout.tsx */}

      {/* CHAT PANEL */}
      <ChatPanel
        visible={showChatPanel}
        onClose={() => setShowChatPanel(false)}
        rideId={effectiveRideId}
        clientName={chatRideInfo?.clientName || 'Client'}
        clientId={chatRideInfo?.clientId || ''}
        driverName={driverData ? `${driverData.profile?.firstName || ''} ${driverData.profile?.lastName || ''}`.trim() || 'Driver' : 'Driver'}
        pickupAddress={chatRideInfo?.pickupAddress || 'Pickup'}
        destinationAddress={chatRideInfo?.destinationAddress || 'Destination'}
        rideStatus={effectiveRideStatus}
        workflowType={workflowType as 'direct_trip' | 'store_delivery' | null}
        isBusy={isBusy}
        isOnline={isOnline}
      />

      {/* INBOX PANEL - past conversations */}
      <InboxPanel
        visible={showInboxPanel}
        onClose={() => setShowInboxPanel(false)}
        driverId={driverId}
      />

      {/* TOAST NOTIFICATION */}
      <ToastNotification
        visible={showToast}
        clientName={toastData.clientName}
        message={toastData.message}
        onHide={() => setShowToast(false)}
      />

      {/* FULL SCREEN MAP BACKGROUND - real interactive map */}
      <View style={styles.mapFullScreen}>
        <DriverMap
          polyline={showPolyline ? activePolyline || undefined : undefined}
          vehiclePosition={vehiclePosition || undefined}
          vehicleType={vehicleType}
          vehicleColor={vehicleColor}
          markers={displayedMarkers}
          arrivalTime={arrivalTime}
          arrivalPosition={arrivalPosition}
          hasActiveTrip={hasActiveTrip}
        />
        {isOnline && locationPermissionDenied && (
          <View style={{ position: 'absolute', top: 18, left: 16, right: 16, padding: 10, borderRadius: 8, backgroundColor: 'rgba(255, 248, 220, 0.96)' }}>
            <Text style={{ color: '#765500', textAlign: 'center' }}>Location permission is unavailable. Enable it to share your live position.</Text>
          </View>
        )}
      </View>

      {(() => {
        const liveDriverStatus = String(driverStatus || '').toLowerCase();
        const canCallStore = isStoreWorkflow(workflowType) && storeCallable !== false && (
          (tripStatus === 'accepted' && liveDriverStatus === 'assigned') ||
          (tripStatus === 'at_store' && liveDriverStatus === 'at_store')
        );
        const canCallCustomer = isStoreWorkflow(workflowType) && ['picked_up', 'delivered'].includes(tripStatus || '');
        const canCallRider = workflowType === 'direct_trip' && ['accepted', 'arrived', 'started'].includes(tripStatus || '');
        const callTarget = canCallStore ? 'store' as const : undefined;
        const callLabel = canCallRider ? 'Call rider' : canCallStore ? 'Call store' : 'Call customer';
        const callOrderId = activeTrip?.orderId ?? activeOrder?.orderId ?? null;
        const canCall = !!callOrderId && (canCallRider || canCallStore || canCallCustomer);
        if (!canCall) return null;
        const handleCall = async () => {
          if (callState !== 'idle' || !callOrderId) return;
          try {
            await startCall(callOrderId, callTarget, canCallCustomer ? 'Customer' : canCallRider ? 'Rider' : undefined);
          } catch (error: any) {
            if (error?.status === 409 || error?.status === 403) {
              setToastData({ clientName: '', message: error.message || 'Call is not available.' });
              setShowToast(true);
            }
          }
        };
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={callState === 'idle' ? callLabel : callState === 'calling' ? 'Calling…' : `In call · ${formattedTime}`}
            disabled={callState !== 'idle'}
            onPress={handleCall}
            style={[styles.callButton, callState === 'in-call' && styles.callButtonActive]}
          >
            <Animated.View style={{ opacity: callState === 'calling' ? callPulse : 1 }}>
              <Phone color={callState === 'in-call' ? '#fff' : '#18201b'} size={24} />
            </Animated.View>
            <Text style={[styles.callTimer, callState !== 'in-call' && styles.callTimerLight]}>{callState === 'idle' ? callLabel : callState === 'calling' ? 'Calling…' : `In call · ${formattedTime}`}</Text>
          </TouchableOpacity>
        );
      })()}

      {/* DRAGGABLE SLIDING PANEL - Contains toggle inside */}
      <Animated.View
        style={[
          styles.slidingPanel,
          {
            transform: [
              { translateY: Animated.add(panelY, panelSlideAnim) },
            ],
          },
        ]}
      >
        {/* Panel Handle - Draggable area */}
        <GestureDetector gesture={panelGesture}>
          <View style={styles.panelHandleArea}>
            <View style={styles.panelHandle} />
          </View>
        </GestureDetector>

        {/* Panel Content */}
        <View style={styles.panelContent}>
          {/* Scheduled Requests Card - Always visible when collapsed */}
          <Animated.View style={[styles.scheduledCard, { opacity: cardsFadeAnim, transform: [{ scale: cardsScaleAnim }] }]}>
            <View style={styles.scheduledIconCircle}>
              <Clock color="#666" size={24} />
            </View>
            <View style={styles.scheduledTextContainer}>
              <Text style={styles.scheduledTitle}>New scheduled requests</Text>
              <Text style={styles.scheduledSubtitle}>Choose a request that suits you</Text>
            </View>
          </Animated.View>

          {/* Stats Row */}
          <Animated.View style={[styles.statsRow, { opacity: cardsFadeAnim, transform: [{ scale: cardsScaleAnim }] }]}>
            <View style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text style={styles.statLabel}>Today&apos;s{'\n'}earnings</Text>
              </View>
              {tripHistoryLoading || !driverId ? (
                <View style={styles.statSkeleton} />
              ) : (
                <Text style={styles.statValue}>ZMW {totalEarnings.toFixed(2)}</Text>
              )}
            </View>

            <View style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text style={styles.statLabel}>Activity{'\n'}score</Text>
              </View>
              {isLoading || !driverId ? (
                <View style={styles.statSkeleton} />
              ) : (
                <Text style={styles.statValue}>
                  {driverData?.activityScore == null ? '--' : `${driverData.activityScore}%`}
                </Text>
              )}
            </View>

            <View style={styles.statCard}>
              <View style={styles.statHeader}>
                <Text style={styles.statLabel}>Current{'\n'}rating</Text>
              </View>
              <Text style={styles.statValue}>{(driverData?.rating || 5.0).toFixed(2)}</Text>
            </View>
          </Animated.View>

          {/* TOGGLE - FULL WIDTH inside panel, below stats */}
          <Animated.View
            style={[
              styles.toggleContainer,
              { opacity: cardsFadeAnim, transform: [{ scale: cardsScaleAnim }] },
              (userStatus !== 'approved' || !registrationCompleted) && styles.disabledSlider,
            ]}
            pointerEvents={(userStatus === 'approved' && registrationCompleted) ? 'auto' : 'none'}
          >
            <View
              onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
              style={[styles.slideTrack, isOnline && styles.slideTrackOnline]}
            >
              <Text style={[styles.slideInstructionText, isOnline && styles.slideInstructionTextOnline]}>
                {isOnline ? 'Slide to go offline' : 'Slide to go online'}
              </Text>
              <GestureDetector gesture={gesture}>
                <ReanimatedAnimated.View style={[styles.slideThumb, sliderStyle]}>
                  <Text style={[styles.chevronText, isOnline && styles.chevronTextOnline]}>
                    {isOnline ? '<<' : '>>'}
                  </Text>
                </ReanimatedAnimated.View>
              </GestureDetector>
            </View>
          </Animated.View>
        </View>
      </Animated.View>

      {/* NAV BAR */}
      <View style={styles.bottomNav}>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('home')}>
          <Home color={activeTab === 'home' ? '#4285F4' : '#999'} size={26} />
          <Text style={[styles.navLabel, activeTab === 'home' && styles.navLabelActive]}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={handleInboxPress}>
          <View style={styles.iconWrapper}>
            <Mail color={activeTab === 'inbox' ? '#4285F4' : '#999'} size={26} />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            )}
          </View>
          <Text style={[styles.navLabel, activeTab === 'inbox' && styles.navLabelActive]}>Inbox</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('trips')}>
          <Clock color={activeTab === 'trips' ? '#4285F4' : '#999'} size={26} />
          <Text style={[styles.navLabel, activeTab === 'trips' && styles.navLabelActive]}>Trips</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('settings')}>
          <Settings color={activeTab === 'settings' ? '#4285F4' : '#999'} size={26} />
          <Text style={[styles.navLabel, activeTab === 'settings' && styles.navLabelActive]}>Settings</Text>
        </TouchableOpacity>
      </View>

      {/* BLUR OVERLAY - Show when not approved OR registration not completed */}
      {(userStatus !== 'approved' || !registrationCompleted) && (
        <BlurView intensity={90} style={styles.blurOverlay}>
          <View style={styles.overlayCard}>
            <Text style={styles.overlayTitle}>
              {userStatus === 'rejected'
                ? 'Your application was not approved'
                : userStatus === 'pending'
                  ? 'Your account is under review'
                  : !registrationCompleted
                    ? 'Please complete your registration'
                    : 'Account Status Pending'}
            </Text>
            <Text style={styles.overlayMessage}>
              {userStatus === 'rejected'
                ? 'Please contact support for more information'
                : userStatus === 'pending'
                  ? 'Please wait up to 24 hours'
                  : !registrationCompleted
                    ? 'Complete all required steps to start driving'
                    : 'Please wait while we verify your account'}
            </Text>
          </View>
        </BlurView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E8E8E8' },
  loadingContainer: { justifyContent: 'center', alignItems: 'center' },

  // Full screen map background
  callButton: {
    position: 'absolute',
    right: 16,
    top: '40%',
height: 56,
  paddingHorizontal: 16,
  borderRadius: 28,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  callButtonActive: { backgroundColor: '#16A34A' },
  callTimer: { color: '#fff', fontWeight: '700', fontSize: 13 },
  callTimerLight: { color: '#18201b' },
  mapFullScreen: {
  position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#E8E8E8',
  },
  mapBackground: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mapGrid: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  mapGridVertical: { flexDirection: 'row' },
  mapLine: { flex: 1, borderWidth: 0.5, borderColor: '#D0D0D0', opacity: 0.3 },
  serviceRadius: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
    borderColor: '#00C853',
    backgroundColor: 'rgba(0, 200, 83, 0.08)',
  },
  // Toggle inside panel - FULL WIDTH
  toggleContainer: {
    marginTop: 16,
  },
  slideTrack: {
    height: 56,
    backgroundColor: '#00C853',
    borderRadius: 30,
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 10,
  },
  slideTrackOnline: {
    backgroundColor: '#E53935',
  },
  slideInstructionText: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  slideInstructionTextOnline: {
    // Text stays centered when online
  },
  slideThumb: {
    position: 'absolute',
    left: 4,
    top: 4,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 8,
  },
  chevronText: {
    color: '#00C853',
    fontSize: 20,
    fontWeight: '700',
  },
  chevronTextOnline: {
    color: '#E53935',
  },
  disabledSlider: {
    opacity: 0.5,
  },

  // Sliding panel - slides behind nav bar when collapsed
  // When collapsed: only scheduled requests card visible above nav
  // When expanded: shows all content including toggle
  slidingPanel: {
    position: 'absolute',
    bottom: 85, // Position above nav bar
    left: 0,
    right: 0,
    height: 300, // Total height of panel content
    backgroundColor: '#F5F5F5',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 10,
  },
  panelHandleArea: {
    width: '100%',
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#D0D0D0',
    borderRadius: 2,
  },
  panelContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 100, // Extra space for content behind bottom nav
  },

  // Scheduled requests card
  scheduledCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  scheduledIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#F0F0F0',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  scheduledTextContainer: { flex: 1 },
  scheduledTitle: { fontSize: 15, fontWeight: '600', color: '#1A1A1A', marginBottom: 2 },
  scheduledSubtitle: { fontSize: 13, color: '#888' },

  // Stats row
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#EBEBEB',
  },
  statHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  statLabel: { fontSize: 12, color: '#666', lineHeight: 16 },
  statValue: { fontSize: 18, fontWeight: '700', color: '#000' },
  statSkeleton: { width: 68, height: 22, borderRadius: 4, backgroundColor: '#e6e6e6' },
  bottomNav: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 85,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#E8E8E8',
    paddingBottom: Platform.OS === 'ios' ? 20 : 10,
    paddingTop: 8,
    zIndex: 15, // Always on top - panel slides behind it
    elevation: 25,
  },
  navItem: { alignItems: 'center', justifyContent: 'center' },
  iconWrapper: { position: 'relative' },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: '#FF3B30',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: '#fff',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  navLabel: { fontSize: 11, color: '#999', marginTop: 6 },
  navLabelActive: { color: '#4285F4', fontWeight: '600' },
  blurOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  overlayCard: {
    backgroundColor: 'rgba(255,255,255,0.98)',
    paddingVertical: 36,
    paddingHorizontal: 28,
    borderRadius: 20,
    alignItems: 'center',
  },
  overlayTitle: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
  overlayMessage: { fontSize: 15, color: '#666', textAlign: 'center' },
});



