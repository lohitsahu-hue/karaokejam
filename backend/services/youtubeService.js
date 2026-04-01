const https = require('https');
const config = require('../config');
const log = require('../utils/logger');

function searchYouTube(query, maxResults = 8) {
  return new Promise((resolve, reject) => {
    if (!config.youtube.apiKey) {
      return reject(new Error('YOUTUBE_API_KEY not configured'));
    }

    // Prioritize original audio versions — exclude karaoke/instrumental/covers/lyric videos
    // since the app does its own stem separation via Demucs
    const searchQuery = query + ' official audio -karaoke -instrumental -cover -"with lyrics" -"lyrical video" -"lyrics video"';
    const params = new URLSearchParams({
      part: 'snippet',
      q: searchQuery,
      type: 'video',
      videoCategoryId: '10', // Music
      maxResults: String(Math.min(maxResults * 2, 20)), // fetch extra, filter after
      key: config.youtube.apiKey,
    });

    const url = `https://www.googleapis.com/youtube/v3/search?${params}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            log.error('YouTube API error:', json.error.message);
            return reject(new Error(json.error.message));
          }
          const rawResults = (json.items || []).map(item => ({
            youtubeId: item.id.videoId,
            title: item.snippet.title,
            channel: item.snippet.channelTitle,
            thumbnail: item.snippet.thumbnails?.medium?.url || '',
            publishedAt: item.snippet.publishedAt,
          }));

          // Post-filter: remove karaoke, lyrics, instrumental, cover versions
          const junkPattern = /\b(karaoke|instrumental|cover|with\s+lyrics|lyric(s|al)?\s*(video)?|sing\s*along|backing\s*track)\b/i;
          const filtered = rawResults.filter(r => !junkPattern.test(r.title));
          // Fall back to raw results if filtering removed everything
          const results = filtered.length > 0 ? filtered.slice(0, maxResults) : rawResults.slice(0, maxResults);

          log.info(`YouTube search: "${query}" → ${rawResults.length} raw, ${filtered.length} after filter, returning ${results.length}`);

          // Get durations via videos endpoint
          if (results.length > 0) {
            getDurations(results.map(r => r.youtubeId))
              .then(durations => {
                results.forEach(r => { r.duration = durations[r.youtubeId] || 0; });
                resolve(results);
              })
              .catch(() => resolve(results)); // fallback: no durations
          } else {
            resolve(results);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function getDurations(videoIds) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      part: 'contentDetails',
      id: videoIds.join(','),
      key: config.youtube.apiKey,
    });

    const url = `https://www.googleapis.com/youtube/v3/videos?${params}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const durations = {};
          (json.items || []).forEach(item => {
            durations[item.id] = parseDuration(item.contentDetails.duration);
          });
          resolve(durations);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Parse ISO 8601 duration (PT4M32S) to seconds
function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

module.exports = { searchYouTube };