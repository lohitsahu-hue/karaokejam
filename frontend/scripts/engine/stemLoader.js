// Stem Loader — download and decode stem audio files
const StemLoader = {
  async loadStems(jobId, stemNames) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const stems = [];

    for (const name of stemNames) {
      try {
        const url = API.stemUrl(jobId, name);
        const res = await fetch(url);
        if (!res.ok) { console.warn(`Stem ${name} not found`); continue; }
        const buf = await res.arrayBuffer();
        const audio = await ctx.decodeAudioData(buf);
        stems.push({ name, buffer: audio });
      } catch (e) {
        console.error(`Failed to load stem ${name}:`, e);
      }
    }

    return { ctx, stems };
  },
};