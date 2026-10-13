export class IntegrationUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.status = 503;
    this.code = code;
  }
}

// 用真实适配器替换这些方法。只有收到设备侧确认后，适配器才能返回指令回执。
export const unconfiguredIntegrations = {
  async telemetry(_deviceId) {
    throw new IntegrationUnavailableError('ADAPTER_NOT_CONFIGURED', '设备遥测适配器尚未配置');
  },
  async stream(_deviceId) {
    throw new IntegrationUnavailableError('ADAPTER_NOT_CONFIGURED', '视频流适配器尚未配置');
  },
  async command(_request) {
    throw new IntegrationUnavailableError('COMMAND_ADAPTER_NOT_CONFIGURED', '设备控制适配器尚未配置，未发送指令');
  },
  async measurements(_assetId) {
    throw new IntegrationUnavailableError('ADAPTER_NOT_CONFIGURED', '测量数据适配器尚未配置');
  }
};
