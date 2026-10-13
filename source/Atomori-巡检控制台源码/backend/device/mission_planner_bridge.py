"""Receive a Mission Planner MAVLink mirror. No flight commands or outbound UDP.

HTTP is loopback-only. Ages measure local reception, not end-to-end latency.
"""
import argparse
import json
import math
import socket
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pymavlink import mavutil
from pymavlink.dialects.v20 import ardupilotmega as mavlink


def number(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else None


class Telemetry:
    def __init__(self, source_ip=None, system_id=None, clock=time.monotonic):
        self.source_ip = source_ip
        self.system_id = system_id
        self.clock = clock
        self.lock = threading.Lock()
        self.peer = None
        self.vehicle = None
        self.messages = {}
        self.message_times = {}
        self.boot_times = {}
        self.alerts = []
        self.accepted = 0
        self.bad_packets = 0
        self.datagrams = 0
        self.received_bytes = 0
        self.rejected_source_datagrams = 0
        self.last_datagram_peer = None
        self.last_datagram_time = None
        self.decoded_messages = 0
        self.last_message_type = None

    def record_datagram(self, payload, peer):
        with self.lock:
            self.datagrams += 1
            self.received_bytes += len(payload)
            self.last_datagram_peer = peer[0]
            self.last_datagram_time = self.clock()
            allowed = not ((self.source_ip and peer[0] != self.source_ip) or
                           (self.peer is not None and peer[0] != self.peer[0]))
            if not allowed:
                self.rejected_source_datagrams += 1
            return allowed

    def accept(self, message, peer):
        with self.lock:
            kind = message.get_type()
            if kind == 'BAD_DATA':
                self.bad_packets += 1
                return
            if self.source_ip and peer[0] != self.source_ip:
                return
            self.decoded_messages += 1
            self.last_message_type = kind
            system, component = message.get_srcSystem(), message.get_srcComponent()
            if self.system_id is not None and system != self.system_id:
                return
            if self.peer is not None and peer[0] != self.peer[0]:
                return
            if kind == 'BATTERY_STATUS' and message.id != 0:
                return
            if self.vehicle is None:
                if kind != 'HEARTBEAT' or message.autopilot == mavlink.MAV_AUTOPILOT_INVALID or message.type == mavlink.MAV_TYPE_GCS:
                    return
                self.peer, self.vehicle = peer, (system, component)
            if (system, component) != self.vehicle:
                return
            self.peer = peer
            now = self.clock()
            boot = getattr(message, 'time_boot_ms', None)
            previous = self.boot_times.get(kind)
            if boot is not None and previous is not None and boot <= previous:
                # Reordered/duplicate samples do not renew freshness. After silence,
                # a restarted autopilot may begin again with a lower boot timestamp.
                if boot == previous or now - self.message_times.get(kind, now) <= 5:
                    return
            if boot is not None:
                self.boot_times[kind] = boot
            self.messages[kind] = message
            self.message_times[kind] = now
            self.accepted += 1
            if kind == 'STATUSTEXT':
                text = message.text.decode('utf-8', 'replace') if isinstance(message.text, bytes) else str(message.text)
                # Never present incomplete MAVLink2 text chunks as a full message.
                if getattr(message, 'id', 0) and (getattr(message, 'chunk_seq', 0) or len(text.encode('utf-8')) >= 50):
                    return
                self.alerts.append({'text': text.rstrip('\x00'), 'severity': int(message.severity), 'received': now})
                self.alerts = self.alerts[-20:]

    def snapshot(self):
        with self.lock:
            now = self.clock()
            def age(kind):
                return max(0, now - self.message_times[kind]) if kind in self.message_times else None

            heartbeat = self.messages.get('HEARTBEAT')
            heartbeat_age = age('HEARTBEAT')
            connected = heartbeat is not None and heartbeat_age <= 2
            def current(kind, max_age=3):
                return self.messages.get(kind) if connected and age(kind) is not None and age(kind) <= max_age else None

            def metric(kind, field, unit, convert=lambda value: value, max_age=3, valid=lambda value: True):
                message = self.messages.get(kind)
                raw = getattr(message, field, None) if message else None
                value = number(convert(raw)) if raw is not None and valid(raw) else None
                sample_age = age(kind)
                usable = connected and value is not None and sample_age is not None and sample_age <= max_age
                return {'value': value if usable else None, 'valid': usable, 'unit': unit, 'ageS': sample_age,
                        'maxAgeS': max_age, 'ageBasis': 'local_mavlink_receive', 'source': f'MAVLink {kind}.{field}',
                        'reason': 'VALID' if usable else 'FLIGHT_CONTROLLER_DISCONNECTED' if not connected else 'NO_VALID_SAMPLE' if value is None else 'STALE_OR_INVALID'}

            degrees = lambda value: math.degrees(value)
            metrics = {
                'roll': metric('ATTITUDE', 'roll', 'deg', degrees, 1),
                'pitch': metric('ATTITUDE', 'pitch', 'deg', degrees, 1),
                'heading': metric('VFR_HUD', 'heading', 'deg', max_age=1, valid=lambda v: 0 <= v < 360),
                'airspeed': metric('VFR_HUD', 'airspeed', 'm/s', max_age=1, valid=lambda v: v >= 0),
                'groundspeed': metric('VFR_HUD', 'groundspeed', 'm/s', max_age=1, valid=lambda v: v >= 0),
                'verticalSpeed': metric('VFR_HUD', 'climb', 'm/s', max_age=1),
                'throttle': metric('VFR_HUD', 'throttle', '%', max_age=1, valid=lambda v: 0 <= v <= 100),
                'altitudeMsl': metric('GLOBAL_POSITION_INT', 'alt', 'm', lambda v: v / 1000, 1),
                'relativeAltitude': metric('GLOBAL_POSITION_INT', 'relative_alt', 'm', lambda v: v / 1000, 1),
                'latitude': metric('GLOBAL_POSITION_INT', 'lat', 'deg', lambda v: v / 1e7, 1, lambda v: -900000000 <= v <= 900000000),
                'longitude': metric('GLOBAL_POSITION_INT', 'lon', 'deg', lambda v: v / 1e7, 1, lambda v: -1800000000 <= v <= 1800000000),
                'satellites': metric('GPS_RAW_INT', 'satellites_visible', '', valid=lambda v: v != 255),
                'hdop': metric('GPS_RAW_INT', 'eph', '', lambda v: v / 100, valid=lambda v: v != 65535),
                'gpsFix': metric('GPS_RAW_INT', 'fix_type', '', valid=lambda v: 0 <= v <= 8),
                'rangefinder': metric('RANGEFINDER', 'distance', 'm', max_age=1, valid=lambda v: v > 0),
                'localAltitude': metric('LOCAL_POSITION_NED', 'z', 'm', lambda v: -v, 1),
                'rc3': metric('RC_CHANNELS', 'chan3_raw', 'µs', max_age=1, valid=lambda v: 0 < v < 65535),
                'vibrationX': metric('VIBRATION', 'vibration_x', 'm/s²'),
                'vibrationY': metric('VIBRATION', 'vibration_y', 'm/s²'),
                'vibrationZ': metric('VIBRATION', 'vibration_z', 'm/s²'),
                'ekfFlags': metric('EKF_STATUS_REPORT', 'flags', ''),
                'cpuLoad': metric('SYS_STATUS', 'load', '%', lambda v: v / 10, valid=lambda v: 0 <= v <= 1000),
            }
            # Select one battery source as a group; never mix battery IDs or replace
            # an explicitly unknown BATTERY_STATUS field with SYS_STATUS data.
            battery = current('BATTERY_STATUS')
            if battery and battery.id == 0:
                cells = [v for v in battery.voltages if v != 65535]
                cells.extend(v for v in getattr(battery, 'voltages_ext', []) if v not in (0, 65535))
                metrics['batteryVoltage'] = metric('BATTERY_STATUS', 'voltages', 'V', lambda _: sum(cells) / 1000 if cells else None)
                metrics['batteryCurrent'] = metric('BATTERY_STATUS', 'current_battery', 'A', lambda v: v / 100, valid=lambda v: v != -1)
                metrics['batteryPercent'] = metric('BATTERY_STATUS', 'battery_remaining', '%', valid=lambda v: 0 <= v <= 100)
            else:
                metrics['batteryVoltage'] = metric('SYS_STATUS', 'voltage_battery', 'V', lambda v: v / 1000, valid=lambda v: 0 <= v < 65535)
                metrics['batteryCurrent'] = metric('SYS_STATUS', 'current_battery', 'A', lambda v: v / 100, valid=lambda v: v != -1)
                metrics['batteryPercent'] = metric('SYS_STATUS', 'battery_remaining', '%', valid=lambda v: 0 <= v <= 100)
            # A zero GPS estimate without a position lock is not a valid location.
            if not metrics['gpsFix']['valid'] or metrics['gpsFix']['value'] < 3:
                for key in ('latitude', 'longitude'):
                    metrics[key].update(value=None, valid=False, reason='GPS_NO_FIX')
            extended = current('EXTENDED_SYS_STATE', 2)
            sys_status = current('SYS_STATUS')
            health = []
            for label, flag in [('陀螺仪', mavlink.MAV_SYS_STATUS_SENSOR_3D_GYRO), ('加速度计', mavlink.MAV_SYS_STATUS_SENSOR_3D_ACCEL),
                                ('磁力计', mavlink.MAV_SYS_STATUS_SENSOR_3D_MAG), ('气压计', mavlink.MAV_SYS_STATUS_SENSOR_ABSOLUTE_PRESSURE),
                                ('GPS', mavlink.MAV_SYS_STATUS_SENSOR_GPS), ('预解锁检查', mavlink.MAV_SYS_STATUS_PREARM_CHECK)]:
                state = '未上报'
                if sys_status:
                    state = '未安装 / 未报告' if not sys_status.onboard_control_sensors_present & flag else '未启用' if not sys_status.onboard_control_sensors_enabled & flag else '正常' if sys_status.onboard_control_sensors_health & flag else '异常 / 未通过'
                health.append({'label': label, 'state': state})
            return {'deviceId': 'UAV-01', 'source': 'mission-planner-mavlink',
                    'transport': {'listener': 'UDP', 'peerIp': self.peer[0] if self.peer else None,
                                  'systemId': self.vehicle[0] if self.vehicle else None, 'componentId': self.vehicle[1] if self.vehicle else None,
                                  'acceptedMessages': self.accepted, 'badPackets': self.bad_packets, 'ageBasis': 'local_receive_only',
                                  'receivedDatagrams': self.datagrams, 'receivedBytes': self.received_bytes,
                                  'rejectedSourceDatagrams': self.rejected_source_datagrams,
                                  'lastDatagramPeerIp': self.last_datagram_peer,
                                  'lastDatagramAgeS': max(0, now - self.last_datagram_time) if self.last_datagram_time is not None else None,
                                  'decodedMessages': self.decoded_messages, 'lastMessageType': self.last_message_type},
                    'flight': {'connected': connected, 'mode': mavutil.mode_string_v10(heartbeat) if connected else 'DISCONNECTED',
                               'armed': bool(heartbeat.base_mode & mavlink.MAV_MODE_FLAG_SAFETY_ARMED) if connected else None,
                               'stateAgeS': heartbeat_age, 'landedState': {1: 'ON_GROUND', 2: 'IN_AIR', 3: 'TAKEOFF', 4: 'LANDING'}.get(extended.landed_state, 'UNKNOWN') if extended else 'UNKNOWN',
                               'landedStateAgeS': age('EXTENDED_SYS_STATE'), 'metrics': metrics,
                               'details': {'systemStatus': heartbeat.system_status if connected else None, 'health': health, 'healthAgeS': age('SYS_STATUS'),
                                           'alerts': [{'text': item['text'], 'severity': item['severity'], 'ageS': now - item['received']} for item in self.alerts if connected and now - item['received'] <= 30]}}}


def receive(sock, state):
    parsers = OrderedDict()
    while True:
        try:
            payload, peer = sock.recvfrom(65535)
        except OSError:
            return
        if not state.record_datagram(payload, peer):
            continue
        if peer not in parsers:
            if len(parsers) >= 16:
                parsers.popitem(last=False)
            parsers[peer] = mavlink.MAVLink(None)
            parsers[peer].robust_parsing = True
        try:
            messages = parsers[peer].parse_buffer(payload) or []
        except mavlink.MAVError:
            with state.lock:
                state.bad_packets += 1
            continue
        for message in messages:
            state.accept(message, peer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--udp-port', type=int, default=14551)
    parser.add_argument('--http-port', type=int, default=8770)
    parser.add_argument('--source-ip')
    parser.add_argument('--system-id', type=int)
    args = parser.parse_args()
    state = Telemetry(args.source_ip, args.system_id)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', args.udp_port))
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != '/api/status':
                self.send_error(404)
                return
            payload = json.dumps(state.snapshot(), allow_nan=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', args.http_port), Handler)
    threading.Thread(target=receive, args=(sock, state), daemon=True).start()
    print(f'Mission Planner receive-only UDP :{args.udp_port}; HTTP 127.0.0.1:{args.http_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
        server.server_close()


if __name__ == '__main__':
    main()
