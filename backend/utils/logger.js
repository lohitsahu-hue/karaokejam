const prefix = (level) => `[${new Date().toISOString()}] [${level}]`;

module.exports = {
  info: (...args) => console.log(prefix('INFO'), ...args),
  warn: (...args) => console.warn(prefix('WARN'), ...args),
  error: (...args) => console.error(prefix('ERROR'), ...args),
  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') console.log(prefix('DEBUG'), ...args);
  },
};