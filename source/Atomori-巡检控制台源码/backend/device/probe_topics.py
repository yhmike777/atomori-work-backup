"""Read ROS samples only; never publish or request a telemetry rate."""
import json
import math
import time
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import BatteryState, Range
from std_msgs.msg import Float64
from rcl_interfaces.srv import GetParameters
from mavros_msgs.msg import HomePosition, EstimatorStatus
from sensor_msgs.msg import NavSatFix

def number(value):
    return float(value) if math.isfinite(value) else None

rclpy.init()
node = Node('atomori_readonly_probe')
seen = {}
def battery(msg):
    seen['battery'] = {'present': msg.present, 'voltage_v': number(msg.voltage),
        'percentage_fraction': number(msg.percentage), 'current_a': number(msg.current),
        'cell_voltage_v': [number(value) for value in msg.cell_voltage]}
node.create_subscription(BatteryState, '/mavros/battery', battery, qos_profile_sensor_data)
node.create_subscription(Float64, '/mavros/global_position/rel_alt',
    lambda msg: seen.update(relative_home_m=number(msg.data)), qos_profile_sensor_data)
node.create_subscription(Range, '/landing/sensor_range',
    lambda msg: seen.update(range_m=number(msg.range)), qos_profile_sensor_data)
node.create_subscription(HomePosition, '/mavros/home_position/home',
    lambda msg: seen.update(home_altitude_m=number(msg.geo.altitude)), qos_profile_sensor_data)
node.create_subscription(NavSatFix, '/mavros/global_position/raw/fix',
    lambda msg: seen.update(gps_fix_status=msg.status.status, gps_altitude_m=number(msg.altitude)), qos_profile_sensor_data)
node.create_subscription(EstimatorStatus, '/mavros/estimator_status',
    lambda msg: seen.update(estimator_flags=msg.flags, height_innovation_ratio=number(msg.pos_vert_ratio)), qos_profile_sensor_data)
deadline = time.monotonic() + 5
try:
    while time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.2)
    # Read MAVROS's cached parameters only; never set/pull flight-controller parameters.
    service = '/mavros/param/get_parameters'
    if service in dict(node.get_service_names_and_types()):
        client = node.create_client(GetParameters, service)
        request = GetParameters.Request()
        request.names = ['BATT_MONITOR', 'BATT2_MONITOR', 'BATT_VOLT_PIN', 'BATT_CURR_PIN', 'EK3_SRC1_POSZ', 'AHRS_EKF_TYPE']
        future = client.call_async(request)
        rclpy.spin_until_future_complete(node, future, timeout_sec=3)
        if future.done() and future.result() is not None:
            seen['cached_parameters'] = {name: {'type': value.type, 'integer': value.integer_value,
                'double': number(value.double_value)} for name, value in zip(request.names, future.result().values)}
    print(json.dumps(seen, allow_nan=False))
finally:
    node.destroy_node()
    rclpy.shutdown()
