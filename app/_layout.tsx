import { useEffect, useState, useRef } from 'react';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet, Platform } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import flashVideo from '@/assets/videos/flash.mp4';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFrameworkReady } from '@/hooks/useFrameworkReady';
import { RegistrationProvider } from '@/context/RegistrationContext';
import { TripRequestProvider } from '@/context/IncomingRidesContext';
import GlobalTripRequestPanel from '@/components/GlobalTripRequestPanel';
import { CallProvider } from '@/context/CallContext';
import CallOverlay from '@/components/CallOverlay';
import NativeCallsBoot from '@/components/NativeCallsBoot';
import { auth, firestore } from '@/config/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';

function SplashScreen({ onFinish }: { onFinish: () => void }) {
  const player = useVideoPlayer(flashVideo, (videoPlayer) => {
    videoPlayer.loop = false;
    videoPlayer.muted = true;
    if (Platform.OS !== 'web') {
      void Promise.resolve(videoPlayer.play()).catch(() => undefined);
    }
  });

  const onFinishRef = useRef(onFinish);

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  useEffect(() => {
    // Start playback after the VideoView is mounted. This is required on web,
    // where calling play from the player initializer can happen too early.
    if (Platform.OS !== 'web') {
      void Promise.resolve(player.play()).catch(() => undefined);
    }

    const splashTimer = setTimeout(() => {
      onFinishRef.current();
    }, 15000);

    return () => clearTimeout(splashTimer);
  }, [player]);

  return (
    <View style={splashStyles.container}>
      <VideoView
        player={player}
        style={splashStyles.video}
        contentFit="cover"
        nativeControls={false}
      />
    </View>
  );
}

const splashStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0e1a',
  },
  video: {
    flex: 1,
  },
});

export default function RootLayout() {
  useFrameworkReady();
  const [showSplash, setShowSplash] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<string | null>(null);
  const pathname = usePathname();
  
  // Listen for authentication state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!currentUser?.uid) {
      setVerificationStatus(null);
      return;
    }

    const driverRef = doc(firestore, 'drivers', currentUser.uid);
    const unsubscribe = onSnapshot(driverRef, (snapshot) => {
      setVerificationStatus(snapshot.exists() ? snapshot.data().verificationStatus ?? null : null);
    }, () => {
      setVerificationStatus(null);
    });

    return () => unsubscribe();
  }, [currentUser?.uid]);
  
  console.log('[v0] RootLayout render, showSplash:', showSplash);

  if (showSplash) {
    return <SplashScreen onFinish={() => {
      setShowSplash(false);
    }} />;
  }

  // Determine if driver is authenticated - MUST have UID
  const driverUid = currentUser?.uid;
  const isAuthenticated = isAuthReady && !!driverUid;

  // If NOT authenticated: render auth screens WITHOUT dispatch overlay
  if (!isAuthenticated) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <RegistrationProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="registration-terms" />
            <Stack.Screen name="personal-info" />
            <Stack.Screen name="personal-picture" />
            <Stack.Screen name="step2" />
            <Stack.Screen name="step3" />
            <Stack.Screen name="cyclist-step" />
            <Stack.Screen name="license-step" />
            <Stack.Screen name="driver-license-instructions" />
            <Stack.Screen name="selfie-with-license-instructions" />
            <Stack.Screen name="id-step" />
            <Stack.Screen name="ridesDelivery" />
            <Stack.Screen name="vehicle-information" />
            <Stack.Screen name="chooseLocation" />
            <Stack.Screen name="application-submitted" />
            <Stack.Screen name="forgot-password" />
            <Stack.Screen name="dashboard" options={{ gestureEnabled: false }} />
            <Stack.Screen name="+not-found" />
          </Stack>
          <StatusBar style="light" />
        </RegistrationProvider>
      </GestureHandlerRootView>
    );
  }

  // AUTHENTICATED: render with TripRequestProvider and GlobalTripRequestPanel
  // The dispatch popup will ONLY appear here when driver is signed in
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RegistrationProvider>
        <TripRequestProvider>
          <CallProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="registration-terms" />
            <Stack.Screen name="dashboard" options={{ gestureEnabled: false }} />
            <Stack.Screen name="personal-info" />
            <Stack.Screen name="personal-picture" />
            <Stack.Screen name="step2" />
            <Stack.Screen name="step3" />
            <Stack.Screen name="cyclist-step" />
            <Stack.Screen name="license-step" />
            <Stack.Screen name="driver-license-instructions" />
            <Stack.Screen name="selfie-with-license-instructions" />
            <Stack.Screen name="id-step" />
            <Stack.Screen name="ridesDelivery" />
            <Stack.Screen name="vehicle-information" />
            <Stack.Screen name="chooseLocation" />
            <Stack.Screen name="application-submitted" />
            <Stack.Screen name="forgot-password" />
            <Stack.Screen name="+not-found" />
          </Stack>
          {/* Keep the RTDB listener mounted for fast resume, but only expose its effects on the approved driver's dashboard. */}
          {isAuthenticated && verificationStatus === 'approved' && pathname === '/dashboard' && (
            <GlobalTripRequestPanel />
          )}
          <NativeCallsBoot />
          <CallOverlay />
          <StatusBar style="light" />
          </CallProvider>
        </TripRequestProvider>
      </RegistrationProvider>
    </GestureHandlerRootView>
  );
}
