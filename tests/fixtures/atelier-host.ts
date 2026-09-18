/**
 * Test fixture: a minimal defaults-capable Pi Atelier host. Subscribes to the
 * sidebar bus at factory time and records every register/unregister event the
 * extension publishes. The discover handshake is exposed via
 * __atelierHostDiscover so tests can fire it after both extensions have loaded
 * (the publisher only listens — a discover emitted before it subscribes is
 * lost, which is exactly the ordering this fixture must not depend on).
 */
const busEvents: any[] = [];
(globalThis as any).__atelierHostBusEvents = busEvents;

export default function (pi: any) {
	pi.events.on("pi-atelier:sidebar-panels", (data: any) => {
		busEvents.push(data);
	});
	(globalThis as any).__atelierHostDiscover = () => {
		pi.events.emit("pi-atelier:sidebar-panels", {
			version: 1,
			type: "discover",
			requestId: "probe-host",
			capabilities: ["panel-defaults-v1"],
		});
	};
}
