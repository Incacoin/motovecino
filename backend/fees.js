const { SERVICE_FEE, TAXI_COMMISSION_RATE, TAXI_COMMISSION_CAP } = require("./constants");

// Moto paga SERVICE_FEE fijo por viaje. Taxi no tiene tarifa fija (se
// negocia directo con el pasajero), así que paga un % de lo que el chofer
// reportó al completar el viaje, con tope.
function rideFee(ride) {
  if (ride.ride_type === "taxi") {
    return Math.min((ride.agreed_price || 0) * TAXI_COMMISSION_RATE, TAXI_COMMISSION_CAP);
  }
  return SERVICE_FEE;
}

module.exports = { rideFee };
