import AgoraRTC, { IAgoraRTCClient, IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng';
import type { CallCredentials } from './callApi';
export * from './callApi';

export async function joinChannel(credentials: CallCredentials, onRemoteAudio?: (user: unknown) => void) {
  const client: IAgoraRTCClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  let microphone: IMicrophoneAudioTrack | null = null;
  let micError: string | undefined;
  try {
    client.on('user-published', async (user, mediaType) => {
      await client.subscribe(user, mediaType);
      if (mediaType === 'audio') {
        try {
          Promise.resolve(user.audioTrack?.play()).catch(() => undefined);
        } catch {
          // The remote track may be removed while a call is ending.
        }
        onRemoteAudio?.(user);
      }
    });

    try {
      microphone = await AgoraRTC.createMicrophoneAudioTrack();
    } catch (firstError) {
      const first = firstError as Error;
      console.warn('[calls] microphone unavailable:', first?.name, first?.message);
      micError = first?.message || 'Microphone unavailable';
      await new Promise((resolve) => setTimeout(resolve, 700));
      try {
        microphone = await AgoraRTC.createMicrophoneAudioTrack();
        micError = undefined;
      } catch (retryError) {
        const retry = retryError as Error;
        console.warn('[calls] microphone retry failed:', retry?.name, retry?.message);
        micError = retry?.message || micError;
      }
    }

    await client.join(credentials.appId, credentials.channel, credentials.token || null, credentials.uid);
    if (microphone) {
      try {
        await client.publish([microphone]);
      } catch (error) {
        const publishError = error as Error;
        console.warn('[calls] microphone publish failed:', publishError?.name, publishError?.message);
        micError = publishError?.message || 'Microphone unavailable';
        microphone.close();
        microphone = null;
      }
    }

    return {
      micAvailable: !!microphone,
      micError,
      leave: async () => {
        microphone?.close();
        await client.leave();
      },
      setMuted: async (muted: boolean) => {
        await microphone?.setEnabled(!muted);
      },
      enableMicrophone: async () => {
        if (!microphone) {
          microphone = await AgoraRTC.createMicrophoneAudioTrack();
          await client.publish([microphone]);
        }
        await microphone.setEnabled(true);
      },
    };
  } catch (error) {
    (microphone as IMicrophoneAudioTrack | null)?.close();
    await client.leave().catch(() => undefined);
    throw error;
  }
}
