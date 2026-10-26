const Worker = require('./models/Worker');
const { haversineMeters } = require('./geo');

async function findEligibleWorkers(booking, serviceId) {
  const loc = booking.address?.location?.coordinates;
  const workers = await Worker.find({
    verificationStatus: 'approved',
    online: true,
    $or: [{ busyUntil: { $exists: false } }, { busyUntil: { $lte: new Date() } }],
    services: serviceId,
  }).populate('user', 'name status');

  const declined = new Set((booking.declinedBy || []).map(String));
  const scored = [];
  for (const w of workers) {
    if (!w.user || w.user.status !== 'active') continue;
    if (declined.has(String(w.user._id))) continue;
    let distance = null;
    if (loc && w.serviceArea?.coordinates) {
      distance = haversineMeters(
        { lng: loc[0], lat: loc[1] },
        { lng: w.serviceArea.coordinates[0], lat: w.serviceArea.coordinates[1] },
      );
      const max = (w.serviceArea.radiusKm || 12) * 1000;
      if (distance != null && distance > max) continue;
    }
    scored.push({
      workerUserId: w.user._id,
      worker: w,
      distance,
      score: (distance == null ? 5000 : distance) - w.ratingAvg * 200,
    });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored;
}

module.exports = { findEligibleWorkers };
