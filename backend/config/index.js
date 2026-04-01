require('dotenv').config();
const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',

  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || '',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  storage: {
    stemsDir: path.resolve(process.env.STEMS_DIR || './storage/stems'),
    downloadsDir: path.resolve(process.env.STEMS_DIR || './storage', 'downloads'),
  },

  demucs: {
    model: process.env.DEMUCS_MODEL || 'hdemucs_mmi',
    mode: process.env.DEMUCS_MODE || 'local', // 'local' or 'runpod'
  },

  runpod: {
    apiKey: process.env.RUNPOD_API_KEY || '',
    endpointId: process.env.RUNPOD_ENDPOINT_ID || '',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
  },

  room: {
    maxGuests: 50,
    idleTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
    codeLength: 6,
  },
};