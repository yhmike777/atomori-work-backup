export const missionId = 'P-20261001-03';

export const site = {
  id: 'SITE-B', name: 'B 区 · 综合舱', mode: 'demo',
  zones: [
    { id: 'A', name: '入口保障区' },
    { id: 'B', name: '综合巡检区' },
    { id: 'C', name: '电力设备区' },
    { id: 'D', name: '给排水区' }
  ],
  archivedLengthKm: 1.28,
  assetCount: 38
};

export const assets = [
  { id: 'AS-A01-001', pointId: 'A-01', name: '入口竖井', zoneId: 'A', kind: 'shaft', chainage: null },
  { id: 'AS-B08-001', pointId: 'B-08', name: '阀组', zoneId: 'B', kind: 'valve', chainage: 'K0+286' },
  { id: 'AS-B09-001', pointId: 'B-09', name: '压力表', zoneId: 'B', kind: 'gauge', chainage: null },
  { id: 'AS-B11-001', pointId: 'B-11', name: '通风机', zoneId: 'B', kind: 'fan', chainage: null },
  { id: 'AS-B12-001', pointId: 'B-12', name: '防火门', zoneId: 'B', kind: 'fire_door', chainage: 'K0+420' },
  { id: 'AS-C06-001', pointId: 'C-06', name: '电缆接头', zoneId: 'C', kind: 'cable_joint', chainage: 'K0+241' },
  { id: 'AS-D10-001', pointId: 'D-10', name: '泵房接口', zoneId: 'D', kind: 'pump_interface', chainage: null }
];

export const mission = {
  id: missionId, name: 'B 区管线例行巡检', siteId: site.id, mode: 'demo',
  status: 'running', phase: 'inspect', currentPointId: 'B-08',
  completedPointCount: 7, totalPointCount: 12,
  pointIds: ['B-01', 'B-02', 'B-03', 'B-04', 'B-05', 'B-06', 'B-07', 'B-08', 'B-09', 'B-10', 'B-11', 'B-12']
};

export const devices = [
  { id: 'UAV-01', kind: 'uav', connection: 'unconfigured', telemetry: 'unconfigured', video: 'unconfigured', command: 'unconfigured', sources: ['flight_controller', 'A8 Mini', 'IMX296', 'MTF-01P'] },
  { id: 'UGV-01', kind: 'ugv', connection: 'unconfigured', telemetry: 'unconfigured', video: 'unconfigured', command: 'unconfigured', sources: ['odometry', 'A2 Mini', 'N10P'] },
  { id: 'DOCK-01', kind: 'dock', connection: 'unconfigured', telemetry: 'unconfigured', video: null, command: 'unconfigured', sources: ['landing', 'interlocks', 'voltage', 'current', 'temperature'] },
  { id: 'H100', kind: 'relay', connection: 'unconfigured', telemetry: 'unconfigured', video: null, command: null, sources: ['AP', 'STA', 'signal_quality'] }
];

export const seedRecords = {
  findings: [
    { id: 'F-001', missionId, assetId: 'AS-B08-001', pointId: 'B-08', source: 'A8 Mini', note: '法兰外观待复核', status: 'pending', createdAt: '2026-10-01T14:32:18+08:00', updatedAt: '2026-10-01T14:32:18+08:00' },
    { id: 'F-002', missionId, assetId: 'AS-C06-001', pointId: 'C-06', source: 'thermal_demo', note: '接头局部温升，最高 48.6°C（样本）', status: 'pending', createdAt: '2026-10-01T14:32:18+08:00', updatedAt: '2026-10-01T14:32:18+08:00' }
  ],
  rechecks: [],
  events: [
    { id: 'E-001', missionId, type: 'demo', title: '空中观察点已到达', detail: 'UAV-01 · 任务执行中', occurredAt: '2026-10-01T14:32:18+08:00' },
    { id: 'E-002', missionId, type: 'demo', title: '视觉参考目标已捕获', detail: 'IMX296 · 目标跟踪有效', occurredAt: '2026-10-01T14:31:52+08:00' }
  ]
};
