// Vehicles and their bookings for delivering and picking up material (RF-CAL-04). Reading needs
// `calendar.read`, since bookings are calendar availability; booking needs `vehicle.book`, and the
// catalog `vehicle.manage`. Only the booker or coordination changes a booking.
import { Router } from "express";

import vehicles from "../access/orchestration/vehicles.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const bookingId = (req) => idParam(req, "id", "booking id");

router.use(authenticate);

router.get("/", requirePermission("calendar.read"), async (_req, res) => {
  res.json({ vehicles: await vehicles.listVehicles() });
});

router.post("/", requirePermission("vehicle.manage"), async (req, res) => {
  res.status(201).json({ vehicle: await vehicles.createVehicle(req.body) });
});

router.get("/bookings", requirePermission("calendar.read"), async (req, res) => {
  const { from, to, vehicleId } = req.query;
  res.json({ bookings: await vehicles.listBookings({ from, to, vehicleId }) });
});

router.post("/bookings", requirePermission("vehicle.book"), async (req, res) => {
  res.status(201).json({ booking: await vehicles.createBooking(req.body) });
});

router.patch("/bookings/:id", requirePermission("vehicle.book"), async (req, res) => {
  res.json({ booking: await vehicles.updateBooking(bookingId(req), req.body) });
});

router.delete("/bookings/:id", requirePermission("vehicle.book"), async (req, res) => {
  await vehicles.deleteBooking(bookingId(req));
  res.status(204).end();
});

router.patch("/:id", requirePermission("vehicle.manage"), async (req, res) => {
  res.json({ vehicle: await vehicles.updateVehicle(idParam(req, "id", "vehicle id"), req.body) });
});

export default router;
