import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Animated,
  PanResponder,
  Platform,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { User, MapPin, Navigation, Hash, Phone, Package, Car, Truck, CheckCircle2 } from 'lucide-react-native';
import { ref, onValue, off } from 'firebase/database';
import { doc, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { database, auth, firestore } from '@/config/firebase';
import { useTripRequest } from '@/context/IncomingRidesContext';
import { normalizeWorkflow, isStoreWorkflow } from '@/utils/workflow';

const { width, height } = Dimensions.get('window');

// Panel positions - TOP ANCHORED (Uber/Bolt style)
const STATUS_BAR_HEIGHT = Platform.OS === 'ios' ? 50 : 30;
const PANEL_HEIGHT = 420;
const HANDLE_HEIGHT = 30;
// Expanded: panel fully visible from top
const PANEL_EXPANDED_Y = 0;
// Minimized: only handle bar and small portion visible
const PANEL_MINIMIZED_Y = -(PANEL_HEIGHT - HANDLE_HEIGHT - STATUS_BAR_HEIGHT);

// RTDB Trip Request structure
interface TripRequest {
  orderId: string;
  workflowType: 'direct_trip' | 'store_delivery' | 'delivery';
  requestType: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  data: {
    pickupAddress: string;
    destinationAddress: string;
    pickupLat: number;
    pickupLng: number;
    dropLat: number;
    dropLng: number;
    stops?: Array<{ address: string; lat: number; lng: number }>;
    total: number;
    fare?: number;
    fee: number;
    driverEarningsAmount?: number;
    currency?: string;
    userName: string;
    userPhone: string;
    serviceType?: string;
    dispatchService?: string;
  };
}

// Fare panel slides down from the top, mirroring the incoming-request panel's
// motion. 360px tall with a scrollable body so the Done button is never pushed
// off-screen on small screens or with large safe-area insets.
const FARE_PANEL_HEIGHT = 360;

// Backend API base URL - REAL BACKEND, NOT LOCAL
const API_BASE = 'https://aletwend-render-backend.onrender.com';

// Formats an amount with an optional currency code/symbol.
function formatMoney(amount: number | undefined, currency?: string): string {
  if (amount == null || isNaN(Number(amount))) return 'ZMW --';
  const value = Number(amount).toFixed(2);
  return `ZMW ${value}`;
}

// Slides down from the top using the same spring motion as the request panel.
// The body scrolls so the Done button is never pushed off-screen.
function FareSummaryPanel({
  data,
  workflowType,
  onDone,
}: {
  data: TripRequest['data'];
  workflowType: TripRequest['workflowType'];
  onDone: () => void;
}) {
  const slideY = useRef(new Animated.Value(-FARE_PANEL_HEIGHT)).current;

  useEffect(() => {
    Animated.spring(slideY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 12,
    }).start();
  }, [slideY]);

  const currency = 'ZMW';
  const total = data?.total ?? data?.fare;
  const fee = data?.fee;
  const isStoreDelivery = isStoreWorkflow(workflowType);
  const customerName = data?.userName || 'Customer';
  // Derive a base fare when both total and fee are present.
  const baseFare =
    typeof total === 'number' && typeof fee === 'number' ? total - fee : undefined;

  return (
    <Animated.View
      style={[fareStyles.panel, { transform: [{ translateY: slideY }] }]}
    >
      <View style={fareStyles.inner}>
        <View style={fareStyles.iconWrap}>
          <CheckCircle2 color="#00C853" size={40} />
        </View>
        <Text style={fareStyles.title}>Trip Completed</Text>

        <ScrollView
          style={fareStyles.scroll}
          contentContainerStyle={fareStyles.scrollContent}
          showsVerticalScrollIndicator={true}
        >
          <Text style={fareStyles.customerLabel}>Customer</Text>
          <Text style={fareStyles.customerName}>{customerName}</Text>

          <View style={fareStyles.totalBox}>
            <Text style={fareStyles.totalLabel}>Total earned</Text>
            <Text style={fareStyles.totalAmount}>{formatMoney(data?.driverEarningsAmount ?? (isStoreDelivery ? fee : total), currency)}</Text>
          </View>

          {(!isStoreDelivery &&
            typeof total === 'number' &&
            typeof fee === 'number' &&
            fee > 0 &&
            fee < total) && (
            <View style={fareStyles.breakdown}>
              {baseFare !== undefined && (
                <View style={fareStyles.breakdownRow}>
                  <Text style={fareStyles.breakdownLabel}>Base fare</Text>
                  <Text style={fareStyles.breakdownValue}>{formatMoney(baseFare, currency)}</Text>
                </View>
              )}
              {typeof fee === 'number' && (
                <View style={fareStyles.breakdownRow}>
                  <Text style={fareStyles.breakdownLabel}>{isStoreDelivery ? 'Delivery fee' : 'Service fee'}</Text>
                  <Text style={fareStyles.breakdownValue}>{formatMoney(fee, currency)}</Text>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        <TouchableOpacity style={fareStyles.doneButton} onPress={onDone}>
          <Text style={fareStyles.doneButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

export default function GlobalTripRequestPanel() {
  const { activeOrder, pendingEarnings, dismissEarning } = useTripRequest();
  const [driverUid, setDriverUid] = useState<string | null>(null);
  const [serverTimeOffset, setServerTimeOffset] = useState(0);
  const [currentRequest, setCurrentRequest] = useState<TripRequest | null>(null);
  const [liveOrder, setLiveOrder] = useState<Record<string, any> | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  // Independent loading states for each button - DO NOT share loading state
  const [isAccepting, setIsAccepting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Fare summary shown to the driver once a trip is fully complete.
  const [showFarePanel, setShowFarePanel] = useState(false);
  const [completedTrip, setCompletedTrip] = useState<{
    orderId: string;
    data: TripRequest['data'];
    workflowType: TripRequest['workflowType'];
  } | null>(null);
  const pendingEarning = pendingEarnings[0] ?? null;
  const showActionError = useCallback((message: string) => {
    if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
    setActionError(message);
    actionErrorTimer.current = setTimeout(() => {
      setActionError(null);
      actionErrorTimer.current = null;
    }, 4000);
  }, []);

  useEffect(() => () => {
    if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
  }, []);

  // Animation value for panel position
  const panelY = useRef(new Animated.Value(PANEL_MINIMIZED_Y)).current;
  const overlayOpacity = useRef(new Animated.Value(0)).current;

  // Live tracking of panelY's current value (avoids stale-closure base position)
  const panelYValue = useRef<number>(PANEL_MINIMIZED_Y);
  // The panelY value captured at the moment a drag begins
  const dragStartY = useRef<number>(PANEL_MINIMIZED_Y);

  useEffect(() => {
    const id = panelY.addListener(({ value }) => {
      panelYValue.current = value;
    });
    return () => panelY.removeListener(id);
  }, [panelY]);

  // Animate panel to position
  const animateToPosition = useCallback((toValue: number, showOverlay: boolean) => {
    Animated.parallel([
      Animated.spring(panelY, {
        toValue,
        useNativeDriver: true,
        tension: 80,
        friction: 12,
      }),
      Animated.timing(overlayOpacity, {
        toValue: showOverlay ? 0.5 : 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [panelY, overlayOpacity]);

  // Pan responder for drag gestures.
  // Created once but reads live position from refs so it never uses a stale base.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dy) > 5,
      onPanResponderGrant: () => {
        // Stop any running animation and capture the ACTUAL current position
        panelY.stopAnimation((value) => {
          dragStartY.current = value;
          panelYValue.current = value;
        });
        // Fallback in case the callback hasn't fired yet
        dragStartY.current = panelYValue.current;
      },
      onPanResponderMove: (_, gestureState) => {
        // Track the finger 1:1 from where the drag started
        const newY = dragStartY.current + gestureState.dy;
        const clampedY = Math.max(
          PANEL_MINIMIZED_Y,
          Math.min(PANEL_EXPANDED_Y, newY)
        );
        panelY.setValue(clampedY);
      },
      onPanResponderRelease: (_, gestureState) => {
        const velocity = gestureState.vy;
        const currentY = Math.max(
          PANEL_MINIMIZED_Y,
          Math.min(PANEL_EXPANDED_Y, dragStartY.current + gestureState.dy)
        );
        const midPoint = (PANEL_MINIMIZED_Y + PANEL_EXPANDED_Y) / 2;

        // Velocity-aware snap: fast swipe wins, otherwise nearest position
        if (velocity < -0.5 || (velocity <= 0.5 && currentY < midPoint)) {
          // Minimize - swipe up
          animateToPosition(PANEL_MINIMIZED_Y, false);
          setIsMinimized(true);
        } else {
          // Expand - swipe down
          animateToPosition(PANEL_EXPANDED_Y, true);
          setIsMinimized(false);
        }
      },
    })
  ).current;

  // Keep provider-owned order fields live while the request panel is open. The
  // RTDB request is only the dispatch snapshot and can lag behind Firestore.
  useEffect(() => {
    const orderId = currentRequest?.orderId;
    if (!orderId) {
      setLiveOrder(null);
      return;
    }

    return onSnapshot(
      doc(firestore, 'orders', orderId),
      (snapshot) => setLiveOrder(snapshot.exists() ? (snapshot.data() as Record<string, any>) : null),
      (error) => {
        console.error('[v0] Live order listener error:', error);
        setLiveOrder(null);
      },
    );
  }, [currentRequest?.orderId]);

  // Countdown timer for incoming requests
  useEffect(() => {
    if (!currentRequest || currentRequest.status !== 'incoming_request') {
      setCountdown(null);
      return;
    }

    const expiresAt = currentRequest.expiresAt;
    if (!expiresAt) return;

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - (Date.now() + serverTimeOffset)) / 1000));
      setCountdown(remaining);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [currentRequest?.orderId, currentRequest?.status, currentRequest?.expiresAt, serverTimeOffset]);

  useEffect(() => onAuthStateChanged(auth, (user) => setDriverUid(user?.uid ?? null)), []);

  useEffect(() => {
    const offsetRef = ref(database, '.info/serverTimeOffset');
    return onValue(offsetRef, (snapshot) => setServerTimeOffset(Number(snapshot.val()) || 0));
  }, []);

  // Listen to driver_trip_requests/{driverUid} - PERMANENT GLOBAL LISTENER
  useEffect(() => {
    if (!driverUid) {
      // No authenticated driver - clear all state and don't start listener
      setCurrentRequest(null);
      setIsVisible(false);
      return;
    }

    const tripRequestsRef = ref(database, `driver_trip_requests/${driverUid}`);
    
    const listener = onValue(tripRequestsRef, (snapshot) => {
      const data = snapshot.val();

      if (!data) {
        // No requests
        if (!currentRequest || ['completed', 'rejected', 'expired', 'cancelled'].includes(currentRequest.status)) {
          setCurrentRequest(null);
          setIsVisible(false);
          animateToPosition(PANEL_MINIMIZED_Y, false);
        }
        return;
      }

      // Get all requests
      const requests = Object.entries(data).map(([orderId, requestData]: [string, any]) => ({
        orderId,
        ...requestData,
      })) as TripRequest[];

      if (requests.length === 0) {
        if (!currentRequest || ['completed', 'rejected', 'expired', 'cancelled'].includes(currentRequest.status)) {
          setCurrentRequest(null);
          setIsVisible(false);
          animateToPosition(PANEL_MINIMIZED_Y, false);
        }
        return;
      }

      const now = Date.now() + serverTimeOffset;
      const activeRequest = requests.find(r =>
        !['completed', 'rejected', 'expired', 'cancelled'].includes(r.status) &&
        !(r.status === 'incoming_request' && r.expiresAt <= now)
      );

      if (activeRequest) {
        const prevStatus = currentRequest?.status;
        setCurrentRequest(activeRequest);

        const isIncoming = activeRequest.status === 'incoming_request';
        if (!isVisible || prevStatus !== activeRequest.status) {
          setIsVisible(true);
          if (isIncoming) {
            setIsMinimized(false);
            animateToPosition(PANEL_EXPANDED_Y, true);
          } else {
            animateToPosition(isMinimized ? PANEL_MINIMIZED_Y : PANEL_EXPANDED_Y, false);
          }
        }

        // Status changes that should hide panel
        if (['completed', 'rejected', 'expired', 'cancelled'].includes(activeRequest.status)) {
          setTimeout(() => {
            setIsVisible(false);
            setCurrentRequest(null);
            animateToPosition(PANEL_MINIMIZED_Y, false);
          }, 1500);
        }
      } else {
        // No active request
        setCurrentRequest(null);
        setIsVisible(false);
        animateToPosition(PANEL_MINIMIZED_Y, false);
      }
    });

    return () => off(tripRequestsRef, 'value', listener);
  }, [driverUid, currentRequest?.status, isVisible, isMinimized, serverTimeOffset, animateToPosition]);

  useEffect(() => {
    if (!activeOrder || currentRequest?.status === 'incoming_request') return;
    if (currentRequest?.orderId === activeOrder.orderId && currentRequest?.status === activeOrder.uiStatus) return;
    const orderData = activeOrder.data ?? activeOrder;
    setCurrentRequest({
      orderId: activeOrder.orderId ?? activeOrder.id,
          workflowType: normalizeWorkflow(activeOrder.workflowType) as TripRequest['workflowType'],
      requestType: normalizeWorkflow(activeOrder.workflowType) ?? 'direct_trip',
      status: activeOrder.uiStatus ?? activeOrder.status,
      createdAt: activeOrder.createdAt ?? 0,
      expiresAt: 0,
      data: {
        ...orderData,
        pickupAddress: activeOrder.pickupAddress,
        destinationAddress: activeOrder.destinationAddress,
        pickupLat: activeOrder.pickupLat,
        pickupLng: activeOrder.pickupLng,
        dropLat: activeOrder.dropLat,
        dropLng: activeOrder.dropLng,
        total: activeOrder.total ?? activeOrder.fare,
        fee: activeOrder.fee,
        userName: activeOrder.userName,
        userPhone: activeOrder.userPhone,
        stops: activeOrder.stops,
      },
    });
    setIsVisible(true);
  }, [activeOrder, currentRequest?.orderId, currentRequest?.status]);

  // CENTRALIZED status update handler - ALL buttons use this same pattern
  // Matches the ACCEPT button behavior which is already working correctly
  const updateTripStatus = async (status: string, confirmEarlyComplete = false) => {
    const user = auth.currentUser;
    const uid = user?.uid;
    if (!currentRequest) return;
    if (!user || !uid) {
      showActionError('Session expired, please sign in again');
      return;
    }

    if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
    actionErrorTimer.current = null;
    setActionError(null);

    if (status === 'accepted') {
      setIsAccepting(true);
    } else if (status === 'declined') {
      setIsRejecting(true);
    } else {
      setIsActionLoading(true);
    }

    try {
      let token: string | undefined;
      try {
        token = await user.getIdToken();
      } catch {
        token = undefined;
      }
      if (!token) {
        showActionError('Session expired, please sign in again');
        return;
      }

      const response = await fetch(`${API_BASE}/updateTripStatus`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: currentRequest.orderId,
          driverId: uid,
          status,
          ...(confirmEarlyComplete ? { confirmEarlyComplete: true } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 401) {
          showActionError('Session expired, please sign in again');
          return;
        }

        if (
          data.code === 'TOO_FAR' &&
          status === 'completed' &&
          normalizeWorkflow(currentRequest.workflowType) === 'direct_trip' &&
          !confirmEarlyComplete
        ) {
          const message = 'You are far from the destination. Complete anyway?';
          const retryWithConfirmation = () => {
            setTimeout(() => void updateTripStatus(status, true), 0);
          };
          if (Platform.OS === 'web') {
            if (typeof window !== 'undefined' && window.confirm(message)) retryWithConfirmation();
          } else {
            Alert.alert('Confirm completion', message, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Complete anyway', onPress: retryWithConfirmation },
            ]);
          }
          return;
        }

        const message =
          data.code === 'TOO_FAR'
            ? `You are ${data.distanceM} m away. Get within ${data.requiredM} m to continue.`
            : data.code === 'LOCATION_STALE'
              ? 'Waiting for a fresh GPS location. Move a little and try again.'
              : data.code === 'INVALID_TRANSITION'
                ? "That step isn't available right now."
                : data.code === 'NOT_YOUR_ORDER'
                  ? 'This trip is no longer assigned to you.'
                  : typeof data.error === 'string'
                    ? data.error
                    : `Failed to update status to ${status}`;
        showActionError(message);
        return;
      }

      // On successful completion, show the fare summary instead of letting the
      // panel silently disappear. Capture the trip data now since the RTDB
      // listener will clear currentRequest shortly after the status flips.
      if (status === 'completed' && currentRequest) {
        const providerOrder = liveOrder || {};
        const requestData = (currentRequest.data || {}) as Record<string, any>;
        const liveField = (field: string) =>
          providerOrder[field] ?? (currentRequest as any)[field] ?? requestData[field];
        setCompletedTrip({
          orderId: currentRequest.orderId,
          data: {
            ...requestData,
            pickupAddress: liveField('pickupAddress'),
            destinationAddress: liveField('destinationAddress'),
            userName: liveField('userName'),
            userPhone: liveField('userPhone'),
            stops: Array.isArray(liveField('stops')) ? liveField('stops') : [],
            total: liveField('total') ?? liveField('fare'),
            fee: liveField('fee'),
            currency: 'ZMW',
          } as TripRequest['data'],
          workflowType: normalizeWorkflow(currentRequest.workflowType) as TripRequest['workflowType'],
        });
        setShowFarePanel(true);
      }
      // DO NOT manually update state - WAIT for RTDB status update
    } catch (error) {
      console.error(`[v0] Error updating trip status to ${status}:`, error);
      showActionError('Unable to update trip status. Please try again.');
    } finally {
      setIsAccepting(false);
      setIsRejecting(false);
      setIsActionLoading(false);
    }
  };

  // All button handlers use the centralized updateTripStatus
  const handleAccept = () => updateTripStatus('accepted');
  const handleReject = () => updateTripStatus('declined');
  const handleArrived = () => updateTripStatus('arrived');
  const handleStartTrip = () => updateTripStatus('started');
  const handleComplete = () => updateTripStatus('completed');
  const handleAtStore = () => updateTripStatus('at_store');
  const handlePickedUp = () => updateTripStatus('picked_up');
  const handleDelivered = () => updateTripStatus('delivered');

  // Render buttons based on workflowType and RTDB status
  const renderButtons = () => {
    if (!currentRequest) return null;

    const { workflowType, status } = currentRequest;

    // DIRECT TRIP flow: incoming_request -> accepted -> arrived -> started -> completed
    if (workflowType === 'direct_trip') {
      switch (status) {
        case 'incoming_request':
          return (
            <View style={styles.buttonRow}>
              <TouchableOpacity 
                style={[styles.rejectButton, isRejecting && styles.buttonDisabled]} 
                onPress={handleReject}
                disabled={isRejecting || isAccepting}
              >
                {isRejecting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Reject</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.acceptButton, isAccepting && styles.buttonDisabled]} 
                onPress={handleAccept}
                disabled={isAccepting || isRejecting}
              >
                {isAccepting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Accept</Text>
                )}
              </TouchableOpacity>
            </View>
          );
        case 'accepted':
          return (
            <TouchableOpacity 
              style={[styles.actionButton, styles.arrivedButton, isActionLoading && styles.buttonDisabled]} 
              onPress={handleArrived}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.buttonText}>Arrived</Text>
              )}
            </TouchableOpacity>
          );
        case 'arrived':
          return (
            <TouchableOpacity 
              style={[styles.actionButton, styles.startButton, isActionLoading && styles.buttonDisabled]} 
              onPress={handleStartTrip}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.buttonText}>Start Trip</Text>
              )}
            </TouchableOpacity>
          );
        case 'started':
          return (
            <TouchableOpacity 
              style={[styles.actionButton, styles.completeButton, isActionLoading && styles.buttonDisabled]} 
              onPress={handleComplete}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.buttonText}>Complete</Text>
              )}
            </TouchableOpacity>
          );
        case 'completed':
        case 'rejected':
        case 'expired':
        case 'cancelled':
          return null;
        default:
          return null;
      }
    }

    // DELIVERY flow: incoming_request -> accepted -> at_store -> picked_up -> delivered -> completed
    if (isStoreWorkflow(workflowType)) {
      switch (status) {
        case 'incoming_request':
          return (
            <View style={styles.buttonRow}>
              <TouchableOpacity 
                style={[styles.rejectButton, isRejecting && styles.buttonDisabled]} 
                onPress={handleReject}
                disabled={isRejecting || isAccepting}
              >
                {isRejecting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Reject</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.acceptButton, isAccepting && styles.buttonDisabled]} 
                onPress={handleAccept}
                disabled={isAccepting || isRejecting}
              >
                {isAccepting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Accept</Text>
                )}
              </TouchableOpacity>
            </View>
          );
        case 'accepted':
          return (
            <TouchableOpacity 
              style={[styles.actionButton, styles.atStoreButton, isActionLoading && styles.buttonDisabled]} 
              onPress={handleAtStore}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.buttonText}>At Store</Text>
              )}
            </TouchableOpacity>
          );
        case 'at_store':
          return (
            <TouchableOpacity 
              style={[styles.actionButton, styles.pickedUpButton, isActionLoading && styles.buttonDisabled]} 
              onPress={handlePickedUp}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.buttonText}>Picked Up</Text>
              )}
            </TouchableOpacity>
          );
        case 'picked_up':
          return (
            <TouchableOpacity 
              style={[styles.actionButton, styles.deliveredButton, isActionLoading && styles.buttonDisabled]} 
              onPress={handleDelivered}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.buttonText}>Delivered</Text>
              )}
            </TouchableOpacity>
          );
        case 'delivered':
          return (
            <TouchableOpacity 
              style={[styles.actionButton, styles.completeButton, isActionLoading && styles.buttonDisabled]} 
              onPress={handleComplete}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.buttonText}>Complete Delivery</Text>
              )}
            </TouchableOpacity>
          );
        case 'completed':
        case 'rejected':
        case 'expired':
        case 'cancelled':
          return null;
        default:
          return null;
      }
    }

    return null;
  };

  // Get status display text and color
  const getStatusDisplay = () => {
    if (!currentRequest) return { text: '', color: '#666', bgColor: '#E8E8E8' };
    
    const statusMap: Record<string, { text: string; color: string; bgColor: string }> = {
      incoming_request: { text: 'New Request', color: '#FF6B00', bgColor: '#FFF3E0' },
      accepted: { text: 'En Route to Pickup', color: '#2196F3', bgColor: '#E3F2FD' },
      arrived: { text: 'At Pickup Location', color: '#4CAF50', bgColor: '#E8F5E9' },
      started: { text: 'Trip in Progress', color: '#9C27B0', bgColor: '#F3E5F5' },
      at_store: { text: 'At Store', color: '#FF9800', bgColor: '#FFF3E0' },
      picked_up: { text: 'Package Picked Up', color: '#00BCD4', bgColor: '#E0F7FA' },
      delivered: { text: 'Delivered', color: '#8BC34A', bgColor: '#F1F8E9' },
      completed: { text: 'Completed', color: '#4CAF50', bgColor: '#E8F5E9' },
      rejected: { text: 'Rejected', color: '#F44336', bgColor: '#FFEBEE' },
      expired: { text: 'Expired', color: '#9E9E9E', bgColor: '#F5F5F5' },
      cancelled: { text: 'Cancelled', color: '#F44336', bgColor: '#FFEBEE' },
    };
    
    return statusMap[currentRequest.status] || { text: currentRequest.status, color: '#666', bgColor: '#E8E8E8' };
  };

  // Get workflow icon
  const getWorkflowIcon = () => {
    if (!currentRequest) return <Car color="#333" size={20} />;
    
    if (isStoreWorkflow(currentRequest.workflowType)) {
      return <Package color="#FF6B00" size={20} />;
    }
    
    const serviceType = currentRequest.data?.serviceType;
    if (serviceType === 'truck' || serviceType === 'delivery_truck') {
      return <Truck color="#333" size={20} />;
    }
    
    return <Car color="#333" size={20} />;
  };

  // Clears all active-trip state. Mirrors the cleanup that runs when a request
  // reaches a terminal status, and is triggered by the fare panel's Done button.
  const handleFareDone = async () => {
    const orderId = completedTrip?.orderId ?? pendingEarning?.orderId ?? pendingEarning?.id;
    if (!orderId) return;

    dismissEarning(orderId);
    setShowFarePanel(false);
    setCompletedTrip(null);
    setCurrentRequest(null);
    setIsVisible(false);
    animateToPosition(PANEL_MINIMIZED_Y, false);

    const acknowledge = async () => {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return false;
      const response = await fetch(`${API_BASE}/ackDriverEarnings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      return response.ok;
    };

    try {
      if (await acknowledge()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      await acknowledge();
    } catch {}
  };

  // CRITICAL: Do NOT render if driver is not authenticated
  if (!driverUid) {
    return null;
  }

  // Once a trip completes, show the fare summary (it owns the screen until the
  // driver taps Done) even though currentRequest may already be cleared.
  const restoredEarning = !completedTrip && currentRequest?.status !== 'incoming_request' ? pendingEarning : null;
  if (showFarePanel && completedTrip) {
    return (
      <FareSummaryPanel
        data={completedTrip.data}
        workflowType={completedTrip.workflowType}
        onDone={handleFareDone}
      />
    );
  }
  if (restoredEarning) {
    return (
      <FareSummaryPanel
        data={{
          ...restoredEarning,
          workflowType: normalizeWorkflow(restoredEarning.workflowType),
          total: restoredEarning.total ?? restoredEarning.fare,
          driverEarningsAmount: restoredEarning.driverEarningsAmount,
          currency: restoredEarning.driverEarningsCurrency || 'ZMW',
          stops: Array.isArray(restoredEarning.stops) ? restoredEarning.stops : [],
        }}
        workflowType={restoredEarning.workflowType}
        onDone={handleFareDone}
      />
    );
  }

  // Do not render if no active request or not visible
  if (!isVisible || !currentRequest) return null;

  const requestData = (currentRequest.data || {}) as Record<string, any>;
  const providerOrder = liveOrder || {};
  const liveValue = (field: string) =>
    providerOrder[field] ?? (currentRequest as any)[field] ?? requestData[field];
  const pickupAddress = liveValue('pickupAddress') || 'Unknown location';
  const destinationAddress = liveValue('destinationAddress') || 'Unknown destination';
  const userName = liveValue('userName') || 'Customer';
  const userPhone = liveValue('userPhone');
  const stops = Array.isArray(liveValue('stops')) ? liveValue('stops') : [];
  const liveData = {
    ...requestData,
    pickupAddress,
    destinationAddress,
    userName,
    userPhone,
    stops,
      total: liveValue('total') ?? liveValue('fare'),
    fee: liveValue('fee'),
    currency: 'ZMW',
  } as TripRequest['data'];
  const statusDisplay = getStatusDisplay();

  return (
    <>
      {/* OVERLAY - only visible when panel is expanded */}
      <Animated.View 
        style={[
          styles.overlay,
          { opacity: overlayOpacity }
        ]}
        pointerEvents={isMinimized || currentRequest.status !== 'incoming_request' ? 'none' : 'auto'}
      />

      {/* TOP-ANCHORED DRAGGABLE PANEL */}
      <Animated.View
        style={[
          styles.panel,
          {
            transform: [{ translateY: panelY }],
          },
        ]}
      >
        {/* Panel content */}
        <View style={styles.content}>
          {/* Status badge with countdown */}
          <View style={styles.statusRow}>
            <View style={[styles.statusBadge, { backgroundColor: statusDisplay.bgColor }]}>
              <Text style={[styles.statusText, { color: statusDisplay.color }]}>
                {statusDisplay.text}
              </Text>
            </View>
            {countdown !== null && currentRequest.status === 'incoming_request' && (
              <View style={styles.countdownBadge}>
                <Text style={styles.countdownText}>{countdown}s</Text>
              </View>
            )}
          </View>

          {/* Order ID and workflow type */}
          <View style={styles.orderInfoRow}>
            {getWorkflowIcon()}
            <View style={styles.orderIdContainer}>
              <Hash color="#999" size={12} />
              <Text style={styles.orderIdText}>
                {currentRequest.orderId.length > 16 
                  ? `${currentRequest.orderId.slice(0, 16)}...` 
                  : currentRequest.orderId}
              </Text>
            </View>
          </View>

          {/* Scrollable info: customer, pickup, stops, destination.
              Scrolls independently so extra stops never push the buttons
              off the panel. */}
          <ScrollView
            style={styles.infoScroll}
            contentContainerStyle={styles.infoScrollContent}
            showsVerticalScrollIndicator={true}
            nestedScrollEnabled={true}
          >
            {/* Customer info */}
            <View style={styles.infoRow}>
              <View style={styles.iconCircle}>
                <User color="#333" size={18} />
              </View>
              <View style={styles.infoContent}>
                <Text style={styles.label}>Customer</Text>
                <Text style={styles.value}>{userName}</Text>
              </View>
              {userPhone && (
                <TouchableOpacity style={styles.phoneButton}>
                  <Phone color="#4CAF50" size={18} />
                </TouchableOpacity>
              )}
            </View>

            {/* Pickup */}
            <View style={styles.infoRow}>
              <View style={[styles.iconCircle, styles.pickupIcon]}>
                <MapPin color="#fff" size={16} />
              </View>
              <View style={styles.infoContent}>
                <Text style={styles.label}>Pickup</Text>
                <Text style={styles.value} numberOfLines={2}>{pickupAddress}</Text>
              </View>
            </View>

            {/* Stops (between pickup and destination) */}
            {stops.map((stop: { address: string; lat: number; lng: number }, index: number) => (
              <View style={styles.infoRow} key={`stop-${index}`}>
                <View style={[styles.iconCircle, styles.stopIcon]}>
                  <Text style={styles.stopNumber}>{index + 1}</Text>
                </View>
                <View style={styles.infoContent}>
                  <Text style={styles.label}>{`Stop ${index + 1}`}</Text>
                  <Text style={styles.value} numberOfLines={2}>{stop.address}</Text>
                </View>
              </View>
            ))}

            {/* Destination */}
            <View style={styles.infoRow}>
              <View style={[styles.iconCircle, styles.destinationIcon]}>
                <Navigation color="#fff" size={16} />
              </View>
              <View style={styles.infoContent}>
                <Text style={styles.label}>Destination</Text>
                <Text style={styles.value} numberOfLines={2}>{destinationAddress}</Text>
              </View>
            </View>
          </ScrollView>

          {/* Action buttons - fixed, always visible below the scroll area */}
          <View style={styles.buttonContainer}>
            {actionError ? <Text accessibilityRole="alert" style={styles.actionError}>{actionError}</Text> : null}
            {renderButtons()}
          </View>
        </View>

        {/* Handle bar at BOTTOM - draggable area */}
        <View {...panResponder.panHandlers} style={styles.handleContainer}>
          <View style={styles.handleBar} />
          <Text style={styles.handleHint}>
            {isMinimized ? 'Pull down to expand' : 'Swipe up to minimize'}
          </Text>
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 9998,
  },
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: PANEL_HEIGHT,
    backgroundColor: '#fff',
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 25,
    zIndex: 9999,
  },
  content: {
    flex: 1,
    paddingTop: STATUS_BAR_HEIGHT,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  handleContainer: {
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
  },
  handleBar: {
    width: 48,
    height: 5,
    backgroundColor: '#DDD',
    borderRadius: 3,
  },
  handleHint: {
    marginTop: 4,
    fontSize: 11,
    color: '#999',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 12,
  },
  statusBadge: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '700',
  },
  countdownBadge: {
    backgroundColor: '#FF6B00',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  countdownText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  orderInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 16,
  },
  orderIdContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  orderIdText: {
    fontSize: 12,
    color: '#999',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  infoScroll: {
    flex: 1,
  },
  infoScrollContent: {
    paddingBottom: 8,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F5F5F5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickupIcon: {
    backgroundColor: '#4CAF50',
  },
  destinationIcon: {
    backgroundColor: '#2196F3',
  },
  stopIcon: {
    backgroundColor: '#5B2EFF',
  },
  stopNumber: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  infoContent: {
    marginLeft: 12,
    flex: 1,
  },
  label: {
    fontSize: 11,
    color: '#888',
    marginBottom: 2,
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  phoneButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#E8F5E9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonContainer: {
    marginTop: 'auto',
    marginBottom: 8,
  },
  actionError: {
    color: '#C62828',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  acceptButton: {
    flex: 1,
    backgroundColor: '#00C853',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#00C853',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  rejectButton: {
    flex: 1,
    backgroundColor: '#F44336',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#F44336',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  actionButton: {
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  arrivedButton: {
    backgroundColor: '#2196F3',
    shadowColor: '#2196F3',
  },
  startButton: {
    backgroundColor: '#9C27B0',
    shadowColor: '#9C27B0',
  },
  completeButton: {
    backgroundColor: '#00C853',
    shadowColor: '#00C853',
  },
  atStoreButton: {
    backgroundColor: '#FF9800',
    shadowColor: '#FF9800',
  },
  pickedUpButton: {
    backgroundColor: '#00BCD4',
    shadowColor: '#00BCD4',
  },
  deliveredButton: {
    backgroundColor: '#8BC34A',
    shadowColor: '#8BC34A',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});

const fareStyles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: FARE_PANEL_HEIGHT,
    backgroundColor: '#fff',
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 25,
    zIndex: 9999,
  },
  inner: {
    flex: 1,
    paddingTop: STATUS_BAR_HEIGHT,
    paddingHorizontal: 20,
    paddingBottom: 16,
    alignItems: 'center',
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#E8F5E9',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
  },
  scroll: {
    alignSelf: 'stretch',
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  customerLabel: {
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
  },
  customerName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
    marginBottom: 12,
  },
  totalBox: {
    backgroundColor: '#F5F5F5',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginBottom: 12,
  },
  totalLabel: {
    fontSize: 13,
    color: '#888',
    marginBottom: 4,
  },
  totalAmount: {
    fontSize: 28,
    fontWeight: '800',
    color: '#00C853',
  },
  breakdown: {
    alignSelf: 'stretch',
    paddingHorizontal: 4,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  breakdownLabel: {
    fontSize: 14,
    color: '#666',
  },
  breakdownValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  doneButton: {
    alignSelf: 'stretch',
    backgroundColor: '#00C853',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 12,
    shadowColor: '#00C853',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  doneButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
