import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { auth, firestore } from '@/config/firebase';
import { normalizeWorkflow, isStoreWorkflow } from '@/utils/workflow';

type Period = 'today' | 'week' | 'month';
export type DriverTrip = { id: string; pickup: string; destination: string; amount: number; createdAt: Date | null; workflowType: 'direct_trip' | 'store_delivery' | 'unknown' };

function asDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstString(...values: any[]) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || 'Address unavailable';
}

function firstNumber(...values: any[]) {
  for (const value of values) {
    const number = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

export function useDriverTripHistory(driverId: string | null, period: Period, enabled = true) {
  const [trips, setTrips] = useState<DriverTrip[]>([]);
  const [loading, setLoading] = useState(Boolean(driverId && enabled));
  const [error, setError] = useState<string | null>(null);
  const [activeQueryKey, setActiveQueryKey] = useState<string | null>(null);
  const queryKey = driverId && enabled ? `${driverId}:${period}` : null;

  useEffect(() => {
    if (!driverId || !enabled) {
      setTrips([]);
      setLoading(false);
      setError(null);
      setActiveQueryKey(null);
      return;
    }
    setLoading(true);
    setError(null);
    setActiveQueryKey(`${driverId}:${period}`);
    const q = query(collection(firestore, 'orders'), where('driverId', '==', driverId));
  return onSnapshot(q, (snapshot) => {
    const next = snapshot.docs.flatMap((item) => {
      const data = item.data() as any;
      const status = String(data.status ?? '').toLowerCase();
      const driverStatus = String(data.driverStatus ?? '').toLowerCase();
      if (!['completed', 'delivered'].includes(status) && !['completed', 'delivered'].includes(driverStatus)) return [];
      const workflowType = normalizeWorkflow(String(data.workflowType).toLowerCase()) as 'direct_trip' | 'store_delivery' | null;
      return [{
        id: item.id,
        status: data.status,
        pickup: firstString(data.pickupAddress, data.pickup, data.restaurantName),
        destination: firstString(data.destinationAddress, data.destination, data.dropoffAddress),
        amount: isStoreWorkflow(workflowType)
          ? firstNumber(data.fee, data.driverEarnings)
          : firstNumber(data.total, data.fare, data.fee),
        createdAt: asDate(data.completedAt || data.deliveredAt || data.updatedAt || data.createdAt),
        workflowType: (workflowType === 'direct_trip' || workflowType === 'store_delivery' ? workflowType : 'unknown') as DriverTrip['workflowType'],
      }];
    });
    setTrips(next); setLoading(false);
  }, (error) => { setError(`Unable to load trip history (${error.code}): ${error.message}`); setLoading(false); });
  }, [driverId, period, enabled]);

  const filteredTrips = useMemo(() => {
    const now = new Date();
    return trips.filter((trip) => {
      if (!trip.createdAt) return false;
      if (period === 'today') return trip.createdAt.toDateString() === now.toDateString();
      const start = new Date(now);
      if (period === 'week') start.setDate(now.getDate() - 7);
      else start.setMonth(now.getMonth() - 1);
      return trip.createdAt >= start;
    });
  }, [trips, period]);

  const queryIsLoading = Boolean(queryKey && (loading || activeQueryKey !== queryKey));
  return { trips: filteredTrips, loading: queryIsLoading, error, totalEarnings: filteredTrips.reduce((sum, trip) => sum + trip.amount, 0) };
}
type TodayEarningsState = {
  uid: string | null;
  dateKey: string;
  totalEarnings: number | null;
  loading: boolean;
  serverSnapshotReceived: boolean;
  missingDailyDocument: boolean;
};

const lusakaDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka' });
const lusakaClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lusaka',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function getLusakaDateKey(date = new Date()) {
  return lusakaDateFormatter.format(date);
}

function millisecondsUntilLusakaMidnight() {
  const now = new Date();
  const [year, month, day] = getLusakaDateKey(now).split('-').map(Number);
  const timeParts = lusakaClockFormatter.formatToParts(now);
  const part = (type: string) => Number(timeParts.find((value) => value.type === type)?.value ?? 0);
  const currentLusakaTime = Date.UTC(year, month - 1, day, part('hour'), part('minute'), part('second'), now.getMilliseconds());
  const nextLusakaMidnight = Date.UTC(year, month - 1, day + 1);
  return Math.max(1000, nextLusakaMidnight - currentLusakaTime + 50);
}

function earningsCacheKey(uid: string, dateKey: string) {
  return `earnings:${uid}:${dateKey}`;
}

function readCachedEarnings(uid: string, dateKey: string): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const value = localStorage.getItem(earningsCacheKey(uid, dateKey));
    if (value === null) return null;
    const total = Number(value);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

function cacheEarnings(uid: string, dateKey: string, total: number) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(earningsCacheKey(uid, dateKey), String(total));
    }
  } catch {
    return;
  }
}

export function useTodayEarnings(driverId: string | null) {
  const [dateKey, setDateKey] = useState(() => getLusakaDateKey());
  const [earningsState, setEarningsState] = useState<TodayEarningsState>(() => ({
    uid: null,
    dateKey,
    totalEarnings: null,
    loading: true,
    serverSnapshotReceived: false,
    missingDailyDocument: false,
  }));

  useEffect(() => {
    let midnightTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleMidnightRefresh = () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      midnightTimer = setTimeout(() => {
        setDateKey(getLusakaDateKey());
        scheduleMidnightRefresh();
      }, millisecondsUntilLusakaMidnight());
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setDateKey(getLusakaDateKey());
        scheduleMidnightRefresh();
      }
    });
    scheduleMidnightRefresh();
    return () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      appStateSubscription.remove();
    };
  }, []);

  const stateMatchesDate = earningsState.uid !== null && earningsState.dateKey === dateKey;
  const fallbackEnabled = Boolean(
    driverId && stateMatchesDate && earningsState.serverSnapshotReceived && earningsState.missingDailyDocument,
  );
  const {
    totalEarnings: fallbackTotalEarnings,
    loading: fallbackLoading,
    error: fallbackError,
  } = useDriverTripHistory(driverId, 'today', fallbackEnabled);

  useEffect(() => {
    if (!driverId) {
      setEarningsState({
        uid: null,
        dateKey,
        totalEarnings: null,
        loading: false,
        serverSnapshotReceived: false,
        missingDailyDocument: false,
      });
      return;
    }

    let active = true;
    let unsubscribeDaily: (() => void) | null = null;
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      unsubscribeDaily?.();
      unsubscribeDaily = null;
      if (!active) return;
      if (!user) {
        setEarningsState({
          uid: null,
          dateKey,
          totalEarnings: null,
          loading: true,
          serverSnapshotReceived: false,
          missingDailyDocument: false,
        });
        return;
      }

      const uid = user.uid;
      const cachedTotal = readCachedEarnings(uid, dateKey);
      setEarningsState({
        uid,
        dateKey,
        totalEarnings: cachedTotal,
        loading: cachedTotal === null,
        serverSnapshotReceived: false,
        missingDailyDocument: false,
      });

      const earningsRef = doc(firestore, 'drivers', driverId, 'earnings', dateKey);
      unsubscribeDaily = onSnapshot(earningsRef, { includeMetadataChanges: true }, (snapshot) => {
        if (!active || snapshot.metadata.fromCache) return;
        if (snapshot.exists()) {
          const value = snapshot.data().total;
          const total = typeof value === 'number' ? value : Number(value);
          const safeTotal = Number.isFinite(total) ? total : 0;
          cacheEarnings(uid, dateKey, safeTotal);
          setEarningsState({
            uid,
            dateKey,
            totalEarnings: safeTotal,
            loading: false,
            serverSnapshotReceived: true,
            missingDailyDocument: false,
          });
          return;
        }

        setEarningsState((current) => {
          const isCurrentValue = current.uid === uid && current.dateKey === dateKey;
          return {
            uid,
            dateKey,
            totalEarnings: isCurrentValue ? current.totalEarnings : null,
            loading: isCurrentValue ? current.totalEarnings === null : true,
            serverSnapshotReceived: true,
            missingDailyDocument: true,
          };
        });
      });
    });

    return () => {
      active = false;
      unsubscribeAuth();
      unsubscribeDaily?.();
    };
  }, [driverId, dateKey]);

  useEffect(() => {
    if (!fallbackEnabled || fallbackLoading || fallbackError || !earningsState.uid) return;
    const uid = earningsState.uid;
    cacheEarnings(uid, dateKey, fallbackTotalEarnings);
    setEarningsState((current) => {
      if (current.uid !== uid || current.dateKey !== dateKey || !current.missingDailyDocument) return current;
      return { ...current, totalEarnings: fallbackTotalEarnings, loading: false };
    });
  }, [dateKey, earningsState.dateKey, earningsState.missingDailyDocument, earningsState.uid, fallbackEnabled, fallbackError, fallbackLoading, fallbackTotalEarnings]);

  const currentStateMatchesDate = earningsState.dateKey === dateKey;
  const totalEarnings = currentStateMatchesDate && earningsState.totalEarnings !== null
    ? earningsState.totalEarnings
    : 0;
  const loading = Boolean(driverId && (
    !currentStateMatchesDate || earningsState.loading || earningsState.totalEarnings === null
  ));

  return { totalEarnings, loading, dateKey };
}

export type { Period };
