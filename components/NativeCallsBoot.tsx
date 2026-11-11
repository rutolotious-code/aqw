'use client';

import { useEffect, useRef } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { arrayRemove, arrayUnion, deleteField, doc, updateDoc } from 'firebase/firestore';
import { auth, firestore } from '@/config/firebase';
import { useCall } from '@/context/CallContext';
import { disposeNativeCalls, initNativeCalls, isNative } from '@/utils/nativeCalls';

export default function NativeCallsBoot() {
  const { callId, callState, answerCall } = useCall();
  const activeCallRef = useRef({ callId, callState });
  const answerRef = useRef(answerCall);
  const registrationRef = useRef<{ uid: string; token?: string } | null>(null);

  activeCallRef.current = { callId, callState };
  answerRef.current = answerCall;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const previous = registrationRef.current;
      if (!user) {
        if (previous?.token) {
          await updateDoc(doc(firestore, 'drivers', previous.uid), {
            fcmToken: deleteField(),
            fcmTokens: arrayRemove(previous.token),
          }).catch(() => undefined);
        }
        registrationRef.current = null;
        await disposeNativeCalls();
        return;
      }
      if (!isNative()) return;

      registrationRef.current = { uid: user.uid, token: previous?.uid === user.uid ? previous.token : undefined };
      await initNativeCalls({
        saveToken: async (token) => {
          await updateDoc(doc(firestore, 'drivers', user.uid), {
            fcmToken: token,
            fcmTokens: arrayUnion(token),
          });
          registrationRef.current = { uid: user.uid, token };
        },
        onAnswer: (incomingCallId) => {
          const deadline = Date.now() + 10_000;
          const check = () => {
            const current = activeCallRef.current;
            if (current.callId === incomingCallId && current.callState === 'ringing') {
              void answerRef.current();
              return;
            }
            if (Date.now() < deadline) setTimeout(check, 100);
          };
          check();
        },
      });
    });
    return () => {
      unsubscribe();
      void disposeNativeCalls();
    };
  }, []);

  return null;
}
