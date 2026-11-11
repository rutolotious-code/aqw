import { useState, useEffect } from 'react';
import { ref, onValue, off } from 'firebase/database';
import { doc, onSnapshot } from 'firebase/firestore';
import { database, firestore } from '@/config/firebase';
import { normalizeWorkflow } from '@/utils/workflow';

export interface MarkerDef {
  id: string;
  type: 'pickup' | 'dropoff' | 'stop' | 'store';
  lat: number;
  lng: number;
}

export type WorkflowType = 'direct_trip' | 'store_delivery' | 'delivery';

interface UseActiveTripResult {
  activeTrip: any | null;
  liveOrder: any | null;
  driverStatus: string | null;
  storeCallable: boolean | null;
  tripStatus: string | null;
  workflowType: WorkflowType | null;
  polylineToPickup: string | null;
  polylineToDestination: string | null;
  markers: MarkerDef[];
  showPolyline: boolean;
  activePolyline: string | null;
  etaMinutes: number | null;
  arrivalTime: string | null; // formatted clock time, e.g. "2:45 PM"
}

// Read a coordinate that may be stored in several shapes:
// order.pickupLocation.latitude/longitude OR order.pickupLat/pickupLng
function readCoord(
  order: any,
  objKey: string,
  latKey: string,
  lngKey: string
): { lat: number; lng: number } | null {
  if (!order) return null;

  const obj = order[objKey];
  if (obj && typeof obj.latitude === 'number' && typeof obj.longitude === 'number') {
    return { lat: obj.latitude, lng: obj.longitude };
  }
  if (obj && typeof obj.lat === 'number' && typeof obj.lng === 'number') {
    return { lat: obj.lat, lng: obj.lng };
  }
  if (typeof order[latKey] === 'number' && typeof order[lngKey] === 'number') {
    return { lat: order[latKey], lng: order[lngKey] };
  }
  return null;
}

function buildStopMarkers(order: any): MarkerDef[] {
  const stops = Array.isArray(order?.stops) ? order.stops : [];
  const markers: MarkerDef[] = [];
  stops.forEach((stop: any, index: number) => {
    let lat: number | null = null;
    let lng: number | null = null;
    if (stop?.location && typeof stop.location.latitude === 'number') {
      lat = stop.location.latitude;
      lng = stop.location.longitude;
    } else if (typeof stop?.latitude === 'number') {
      lat = stop.latitude;
      lng = stop.longitude;
    } else if (typeof stop?.lat === 'number') {
      lat = stop.lat;
      lng = stop.lng;
    }
    if (lat != null && lng != null) {
      markers.push({ id: `stop-${index + 1}`, type: 'stop', lat, lng });
    }
  });
  return markers;
}

function orderToTrip(order: any) {
  if (!order) return null;
  return {
    ...order,
    orderId: order.orderId ?? order.id,
  workflowType: normalizeWorkflow(order.workflowType),
  requestType: normalizeWorkflow(order.workflowType),
    status: order.uiStatus ?? order.status,
    createdAt: order.createdAt ?? 0,
    expiresAt: 0,
    pickupLat: order.pickupLat ?? order.pickupLocation?.latitude,
    pickupLng: order.pickupLng ?? order.pickupLocation?.longitude,
    dropLat: order.dropLat ?? order.destinationLocation?.latitude,
    dropLng: order.dropLng ?? order.destinationLocation?.longitude,
    pickupAddress: order.pickupAddress,
    destinationAddress: order.destinationAddress,
    stops: order.stops,
    encodedPolyline: order.polyline,
    driverToPickupEncodedPolyline: order.driverToPickupPolyline,
    tripDistanceKm: order.distanceKm,
    tripEtaMinutes: order.durationMinutes,
    total: order.total ?? order.fare,
    fee: order.fee,
    data: order,
  };
}

export function useActiveTrip(driverId: string | null, fallbackOrder?: any | null): UseActiveTripResult {
  const [activeTrip, setActiveTrip] = useState<any | null>(null);
  const [liveOrder, setLiveOrder] = useState<any | null>(null);

  useEffect(() => {
    const orderId = activeTrip?.orderId;
    if (!orderId) {
      setLiveOrder(null);
      return;
    }
    return onSnapshot(
      doc(firestore, 'orders', orderId),
      (snapshot) => setLiveOrder(snapshot.exists() ? snapshot.data() : null),
      () => setLiveOrder(null),
    );
  }, [activeTrip?.orderId]);

  useEffect(() => {
    if (!driverId) {
      setActiveTrip(null);
      return;
    }

    // Same path pattern used in dashboard.tsx and IncomingRidesContext.tsx:
    // RTDB driver_trip_requests/{driverId} keyed by request id
    const tripRequestsRef = ref(database, `driver_trip_requests/${driverId}`);

    const listener = onValue(
      tripRequestsRef,
      (snapshot) => {
        const data = snapshot.val();
        if (!data) {
          setActiveTrip(null);
          return;
        }
        // Pick the first active (non-terminal) request
        const terminal = ['completed', 'cancelled', 'rejected', 'expired'];
        const requests = Object.values(data) as any[];
        const activeRequest = requests.find((r) => !terminal.includes(r?.status)) || null;
        setActiveTrip(activeRequest ? { ...activeRequest, workflowType: normalizeWorkflow(activeRequest.workflowType), requestType: normalizeWorkflow(activeRequest.requestType) } : null);
      },
      (error) => {
        console.log('[v0] useActiveTrip listener error:', error.message);
        setActiveTrip(null);
      }
    );

    return () => off(tripRequestsRef, 'value', listener);
  }, [driverId]);

  const fallbackTrip = !activeTrip ? orderToTrip(fallbackOrder) : null;
  const tripSource = activeTrip ?? fallbackTrip;
  const liveTrip = tripSource && liveOrder
    ? { ...liveOrder, ...tripSource, status: tripSource.status, workflowType: normalizeWorkflow(tripSource.workflowType ?? tripSource.requestType) }
    : tripSource;
  const tripStatus: string | null = liveTrip?.status ?? null;
  const workflowType: WorkflowType | null =
    normalizeWorkflow(liveTrip?.workflowType ?? liveTrip?.requestType) as WorkflowType | null;
  const polylineToPickup: string | null = liveOrder?.driverToPickupPolyline ?? tripSource?.driverToPickupEncodedPolyline ?? null;
  const polylineToDestination: string | null = liveOrder?.polyline ?? tripSource?.encodedPolyline ?? null;
  const mergedStops = liveOrder?.stops ?? activeTrip?.stops ?? [];
  const mergedFare = liveOrder?.fare ?? activeTrip?.fare;
  const mergedTotal = liveOrder?.total ?? activeTrip?.total;
  const mergedFee = liveOrder?.fee ?? activeTrip?.fee;
  const mergedDistance = liveOrder?.distance ?? activeTrip?.distance;
  const mergedEta = liveOrder?.tripEtaMinutes ?? activeTrip?.tripEtaMinutes;
  const mergedTrip = { ...liveTrip, stops: mergedStops, fare: mergedFare, total: mergedTotal, fee: mergedFee, distance: mergedDistance, tripEtaMinutes: mergedEta };

  // Compute markers and active polyline based on status + workflow
  let markers: MarkerDef[] = [];
  let activePolyline: string | null = null;

  if (liveTrip && tripStatus && workflowType) {
    const pickup = readCoord(mergedTrip, 'pickupLocation', 'pickupLat', 'pickupLng');
    const dropoff = readCoord(mergedTrip, 'destinationLocation', 'dropLat', 'dropLng');
    const store = readCoord(mergedTrip, 'storeLocation', 'storeLat', 'storeLng') || pickup;
    const stopMarkers = buildStopMarkers(mergedTrip);

    if (workflowType === 'direct_trip') {
      switch (tripStatus) {
        case 'accepted':
          activePolyline = polylineToPickup;
          if (pickup) markers = [{ id: 'pickup', type: 'pickup', lat: pickup.lat, lng: pickup.lng }];
          break;
        case 'arrived':
          activePolyline = null;
          markers = [];
          break;
        case 'started':
          activePolyline = polylineToDestination;
          markers = [
            ...(dropoff ? [{ id: 'dropoff', type: 'dropoff' as const, lat: dropoff.lat, lng: dropoff.lng }] : []),
            ...stopMarkers,
          ];
          break;
        case 'completed':
        default:
          activePolyline = null;
          markers = [];
          break;
      }
    } else if ((workflowType === 'store_delivery' || workflowType === 'delivery')) {
      switch (tripStatus) {
        case 'accepted':
          activePolyline = polylineToPickup;
          if (store) markers = [{ id: 'store', type: 'store', lat: store.lat, lng: store.lng }];
          break;
        case 'at_store':
          activePolyline = null;
          markers = [];
          break;
        case 'picked_up':
          activePolyline = polylineToDestination;
          markers = [
            ...(dropoff ? [{ id: 'dropoff', type: 'dropoff' as const, lat: dropoff.lat, lng: dropoff.lng }] : []),
            ...stopMarkers,
          ];
          break;
        case 'delivered':
        case 'completed':
        default:
          activePolyline = null;
          markers = [];
          break;
      }
    }
  }

  const showPolyline = activePolyline != null;

  // ---- ETA + arrival time ----
  // Same status/workflow switch as above:
  //   accepted (driver -> pickup/store) => driverToPickupEtaMinutes
  //   started / picked_up (pickup -> destination) => tripEtaMinutes
  //   all other statuses (arrived, at_store, delivered, completed, none) => null
  let etaMinutes: number | null = null;
  if (liveTrip && tripStatus && workflowType) {
    if (workflowType === 'direct_trip') {
      if (tripStatus === 'accepted') {
        etaMinutes = liveTrip?.driverToPickupEtaMinutes ?? null;
      } else if (tripStatus === 'started') {
        etaMinutes = liveTrip?.tripEtaMinutes ?? null;
      }
    } else if ((workflowType === 'store_delivery' || workflowType === 'delivery')) {
      if (tripStatus === 'accepted') {
        etaMinutes = liveTrip?.driverToPickupEtaMinutes ?? null;
      } else if (tripStatus === 'picked_up') {
        etaMinutes = liveTrip?.tripEtaMinutes ?? null;
      }
    }
  }

  // Recompute fresh each render — never cache a stale timestamp.
  const arrivalTime =
    etaMinutes !== null
      ? new Date(Date.now() + etaMinutes * 60000).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })
      : null;

  return {
    activeTrip,
    liveOrder,
    driverStatus: liveOrder?.driverStatus ?? null,
    storeCallable: activeTrip?.storeCallable ?? liveOrder?.storeCallable ?? null,
    tripStatus,
    workflowType,
    polylineToPickup,
    polylineToDestination,
    markers,
    showPolyline,
    activePolyline,
    etaMinutes,
    arrivalTime,
  };
}
