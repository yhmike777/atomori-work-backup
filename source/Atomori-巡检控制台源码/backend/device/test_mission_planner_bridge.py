import socket
import threading
import time
import unittest

from mission_planner_bridge import Telemetry, receive
from pymavlink.dialects.v20 import ardupilotmega as mavlink


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.now = [100.0]
        self.state = Telemetry(clock=lambda: self.now[0])
        self.encoder = mavlink.MAVLink(None, srcSystem=1, srcComponent=1)
        self.peer = ('192.168.1.8', 12345)

    def accept(self, message, encoder=None, peer=None):
        packet = message.pack(encoder or self.encoder)
        parsed = mavlink.MAVLink(None).parse_buffer(packet)[0]
        self.state.accept(parsed, peer or self.peer)

    def heartbeat(self):
        self.accept(self.encoder.heartbeat_encode(mavlink.MAV_TYPE_QUADROTOR, mavlink.MAV_AUTOPILOT_ARDUPILOTMEGA, mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, 4, mavlink.MAV_STATE_STANDBY))

    def test_waiting_and_heartbeat_expiry(self):
        self.assertFalse(self.state.snapshot()['flight']['connected'])
        self.heartbeat()
        self.assertEqual(self.state.snapshot()['flight']['mode'], 'GUIDED')
        self.assertIs(self.state.snapshot()['flight']['armed'], False)
        self.now[0] += 2.1
        self.assertFalse(self.state.snapshot()['flight']['connected'])

    def test_datagram_diagnostics_do_not_accept_wrong_source(self):
        state = Telemetry(source_ip='192.168.1.7', clock=lambda: self.now[0])
        self.assertFalse(state.record_datagram(b'abc', ('192.168.1.8', 1000)))
        self.assertTrue(state.record_datagram(b'defgh', ('192.168.1.7', 1000)))
        self.now[0] += 1
        transport = state.snapshot()['transport']
        self.assertEqual(transport['receivedDatagrams'], 2)
        self.assertEqual(transport['receivedBytes'], 8)
        self.assertEqual(transport['rejectedSourceDatagrams'], 1)
        self.assertEqual(transport['lastDatagramPeerIp'], '192.168.1.7')
        self.assertEqual(transport['lastDatagramAgeS'], 1)
        self.assertEqual(transport['acceptedMessages'], 0)
        self.assertFalse(state.snapshot()['flight']['connected'])

    def test_gcs_wrong_source_and_wrong_vehicle_do_not_become_uav(self):
        self.accept(self.encoder.heartbeat_encode(mavlink.MAV_TYPE_GCS, mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 4))
        self.assertIsNone(self.state.vehicle)
        self.heartbeat()
        other = mavlink.MAVLink(None, srcSystem=2, srcComponent=1)
        self.accept(other.attitude_encode(1, 1, 1, 1, 0, 0, 0), other)
        self.accept(self.encoder.attitude_encode(1, 1, 1, 1, 0, 0, 0), peer=('192.168.1.77', 12345))
        self.assertIsNone(self.state.snapshot()['flight']['metrics']['roll']['value'])
        self.accept(self.encoder.attitude_encode(1, 0, -0.1, 0, 0, 0, 0), peer=(self.peer[0], 55555))
        self.assertEqual(self.state.snapshot()['flight']['metrics']['roll']['value'], 0)

    def test_unknown_battery_zero_values_and_independent_expiry(self):
        self.heartbeat()
        self.accept(self.encoder.sys_status_encode(0, 0, 0, 100, 65535, -1, -1, 0, 0, 0, 0, 0, 0))
        metrics = self.state.snapshot()['flight']['metrics']
        for key in ('batteryVoltage', 'batteryCurrent', 'batteryPercent'):
            self.assertIsNone(metrics[key]['value'])
        self.accept(self.encoder.sys_status_encode(0, 0, 0, 100, 23800, 0, 0, 0, 0, 0, 0, 0, 0))
        self.accept(self.encoder.attitude_encode(10, 0, 0, 0, 0, 0, 0))
        metrics = self.state.snapshot()['flight']['metrics']
        self.assertEqual(metrics['batteryPercent']['value'], 0)
        self.assertEqual(metrics['batteryCurrent']['value'], 0)
        self.assertEqual(metrics['batteryVoltage']['value'], 23.8)
        self.now[0] += 1.2
        metrics = self.state.snapshot()['flight']['metrics']
        self.assertIsNone(metrics['roll']['value'])
        self.assertEqual(metrics['batteryVoltage']['value'], 23.8)
        self.accept(self.encoder.attitude_encode(10, 0, 0, 0, 0, 0, 0))
        self.assertIsNone(self.state.snapshot()['flight']['metrics']['roll']['value'], 'duplicate timestamp must not renew age')

    def test_battery_instances_do_not_mix(self):
        self.heartbeat()
        self.accept(self.encoder.battery_status_encode(0, 0, 0, 32767, [23800] + [65535] * 9, -1, -1, -1, 0))
        self.accept(self.encoder.battery_status_encode(1, 0, 0, 32767, [12000] + [65535] * 9, 100, 0, 0, 80))
        metrics = self.state.snapshot()['flight']['metrics']
        self.assertEqual(metrics['batteryVoltage']['value'], 23.8)
        self.assertEqual(metrics['batteryPercent']['value'], 0)
        self.assertIsNone(metrics['batteryCurrent']['value'])

    def test_real_udp_parser_and_bad_crc(self):
        # Ephemeral loopback port: test packets never enter the production listener.
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(('127.0.0.1', 0))
        state = Telemetry()
        worker = threading.Thread(target=receive, args=(sock, state), daemon=True)
        worker.start()
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            packet = self.encoder.heartbeat_encode(2, 3, 0, 4, 3).pack(self.encoder)
            corrupt = bytearray(packet); corrupt[-1] ^= 1
            sender.sendto(corrupt, sock.getsockname())
            sender.sendto(packet, sock.getsockname())
            deadline = time.monotonic() + 2
            while state.accepted < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(state.snapshot()['flight']['connected'])
            self.assertGreater(state.bad_packets, 0)
            transport = state.snapshot()['transport']
            self.assertEqual(transport['receivedDatagrams'], 2)
            self.assertEqual(transport['decodedMessages'], 1)
            self.assertEqual(transport['lastMessageType'], 'HEARTBEAT')
        finally:
            sender.close(); sock.close()


if __name__ == '__main__':
    unittest.main()
