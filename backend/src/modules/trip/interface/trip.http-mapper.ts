import { TripWithLegs } from '../infrastructure/trip.repository';

/** Maps the Trip read model to the response shape documented in backend/API.md §4. */
export function toTripResponse(trip: TripWithLegs) {
  return {
    id: trip.id,
    status: trip.status,
    currency: trip.currency,
    anchor: {
      eventLegId: trip.anchorLegId,
      destination: trip.destinationCity
        ? {
            city: trip.destinationCity,
            geo:
              trip.destinationLat != null && trip.destinationLng != null
                ? { lat: trip.destinationLat, lng: trip.destinationLng }
                : null,
          }
        : null,
      arriveBy: trip.arriveBy?.toISOString() ?? null,
    },
    legs: trip.legs.map((l) => ({
      id: l.id,
      type: l.type,
      sequence: l.sequence,
      status: l.status,
      providerRef: l.providerRef,
      price: { amount: Number(l.priceAmount), currency: l.priceCurrency },
    })),
    payment: {
      paymentIntentId: trip.paymentIntentId,
      authorized: { amount: Number(trip.authorizedAmount), currency: trip.currency },
      captured: { amount: Number(trip.capturedAmount), currency: trip.currency },
      refunded: { amount: Number(trip.refundedAmount), currency: trip.currency },
    },
    totals: {
      estimated: {
        amount: trip.legs.reduce((s, l) => s + Number(l.priceAmount), 0),
        currency: trip.currency,
      },
    },
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}
