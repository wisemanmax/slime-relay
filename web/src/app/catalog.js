// Static catalog knowledge shared by the browse views: brand channels, movie
// genres, and the TMDB discover query builder. Pure data, no DOM.

/* ── Brand channels + genres (mirrors CatalogModels.swift) ────────────────────
   The apps grew per-service browse screens; the web had no way to ask "what is
   on Netflix". Same TMDB shape they use: with_watch_providers + a US flatrate
   monetization filter, which is what makes the result the service's actual
   catalog rather than everything it has ever touched.

   2303 is Paramount+, NOT the retired 531 — a US flatrate discover on 531
   returns zero rows, which is why that tile would open an empty channel. */
export const CHANNELS = [
  [8,'Netflix','#2b1013'],[337,'Disney+','#101a2e'],[1899,'Max','#1e1430'],
  [9,'Prime Video','#0c1e2a'],[350,'Apple TV+','#1d1d1f'],[15,'Hulu','#0d2418'],
  [2303,'Paramount+','#0e1a2c'],[386,'Peacock','#241620'],
  [283,'Crunchyroll','#2c1707'],[526,'AMC+','#1e1010'],
];
export const chanName = (pid) => (CHANNELS.find(c => c[0] === +pid) || [0, 'Channel'])[1];

/* TMDB's movie and TV genre ids are DIFFERENT namespaces, and a wrong id is not
   rejected — it silently returns an unfiltered grid. These are the movie ids;
   they are only ever sent to /discover/movie. */
export const GENRES = [
  [28,'Action'],[12,'Adventure'],[16,'Animation'],[35,'Comedy'],[80,'Crime'],
  [99,'Documentary'],[18,'Drama'],[10751,'Family'],[14,'Fantasy'],[36,'History'],
  [27,'Horror'],[10402,'Music'],[9648,'Mystery'],[10749,'Romance'],[878,'Sci-Fi'],
  [10770,'TV Movie'],[53,'Thriller'],[10752,'War'],[37,'Western'],
];

/* Built from an object so an override REPLACES a default instead of appending a
   second copy. TMDB rejects a duplicated parameter outright — "Invalid
   parameters", zero results — and because a short row is dropped, the row then
   vanishes silently rather than erroring. That is how the Top Rated shelf
   disappeared: sort_by and vote_count.gte were each sent twice. */
export const provQ = (pid, extra) => {
  const q = Object.assign({
    with_watch_providers: pid,
    watch_region: 'US',
    with_watch_monetization_types: 'flatrate',
    sort_by: 'popularity.desc',
    'vote_count.gte': '20',
  }, extra || {});
  return Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
};
