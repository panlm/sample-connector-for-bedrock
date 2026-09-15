
import { createLogger, format, transports } from 'winston';

// 单行 JSON 日志（FR-4 / AD-4）：把 winston 默认的 timestamp/message 重映射为 time/msg，
// 每条日志输出一行合法 JSON，便于集中式日志系统逐行采集与结构化检索。
const remapFields = format((info: any) => {
  info.time = info.timestamp;
  delete info.timestamp;
  info.msg = info.message;
  delete info.message;
  return info;
});

export default createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    // format.align(),
    format.errors({ stack: true }),
    remapFields(),
    format.json(),
  ),
  defaultMeta: { service: 'brconnector' },
  transports: [
    // new transports.File({ filename: '/tmp/combined.log' }),
    new transports.Console({
      level: 'info',
    })
  ],
});
