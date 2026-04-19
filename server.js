// Optimized Tracklist Cache Helper - Insert after cache vars (after CACHE_DURATION line)
// Optimized Tracklist Cache Helper - Insert after cache vars (after CACHE_DURATION line)



// Helper to invalidate cache after mutations
function invalidateTracklistCache() {
  console.log("🔄 Cache invalidated due to tracklist mutation");
  globalTracklistCache = [];
  cacheLastUpdated = 0;
}

async function getTracklist() {
  const now = Date.now();
  const cacheValid =
    globalTracklistCache.length > 0 && now - cacheLastUpdated < CACHE_DURATION;

  if (cacheValid) {
    console.log(
      `💾 Cache HIT: ${globalTracklistCache.length} tracks (age: ${(now - cacheLastUpdated) / 1000}s)`,
    );
    return globalTracklistCache;
  }

  console.log("💾 Cache MISS: Fetching fresh tracklist from storage...");
  const freshList = await readTracklistFromStorage();
  globalTracklistCache = freshList;
  cacheLastUpdated = now;
  console.log(`✅ Cache updated: ${freshList.length} tracks`);
  return freshList;
}


