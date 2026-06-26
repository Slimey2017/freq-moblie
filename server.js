/**
 * FREQ — Universal Music Player
 * server.js  ·  v4.1  "The Extractor"
 *
 * © 2025–2026 FREQ / Slimey2017. All rights reserved.
 *
 * ─── API Endpoints ────────────────────────────────────────────────────────────
 * POST /api/resolve              { url: string }
 *   → { platform, type, embedUrl, id, title?, embedBlocked? }
 *
 * POST /api/import               { urls: string[] }
 *
 * POST /api/yt/tracks            { url: string }   ← NEW v4.1
 *   → { type:'playlist'|'video', title, tracks:[{ id, title, duration, thumb }] }
 *   Scrapes ytInitialData from YouTube page — zero API key.
 *   Works for: watch?v=, playlist?list=, /channel/, /@handle, youtu.be/
 *
 * GET  /api/yt/embed-check       ?id=<videoId>     ← NEW v4.1
 *   → { id, embeddable: bool, nocookie: bool }
 *   Checks YouTube oEmbed endpoint to detect embedding restrictions.
 *
 * GET  /health
 * GET  /redirect                 ?url=<encoded>&platform=<name>
 *
 * POST /api/auth/signup          { username, displayName?, password }
 * POST /api/auth/signin          { username, password }
 * POST /api/auth/token-refresh   { token }
 * POST /api/auth/sync            { token, playlists }
 * GET  /api/auth/pull
 * DELETE /api/auth/account       { token }
 *
 * GET    /api/profiles/:username            → public profile (404 if private/missing)
 * PATCH  /api/profiles/me        { token, bio?, displayName?, isPublic? }
 *
 * POST   /api/follows/:username              { token }  → follow
 * DELETE /api/follows/:username              { token }  → unfollow
 * GET    /api/follows/:username/followers    ?limit=&offset=
 * GET    /api/follows/:username/following    ?limit=&offset=
 *
 * POST   /api/playlists                      { token, name, description?, isPublic? }
 * GET    /api/playlists/:id                  ?token=
 * PATCH  /api/playlists/:id                  { token, name?, description?, isPublic? }
 * DELETE /api/playlists/:id                  { token }
 * GET    /api/playlists/mine                 ?token=
 * POST   /api/playlists/:id/tracks           { token, trackData }
 * DELETE /api/playlists/:id/tracks/:rowId    { token }
 * GET    /api/profiles/:username/playlists
 *
 * POST   /api/playlists/:id/like               { token }  → like (idempotent)
 * DELETE /api/playlists/:id/like               { token }  → unlike (idempotent)
 * GET    /api/playlists/liked                  ?token=    → playlists I've liked
 *
 * POST   /api/plays                            { originalUrl, platform?, title?, token? }
 * GET    /api/charts/tracks                    ?window=all|7d&limit=
 *
 * GET    /api/discover/playlists                ?sort=likes|recent&limit=
 * GET    /api/discover/profiles                 ?limit=&token=
 *
 * ─── New in v4.1 ─────────────────────────────────────────────────────────────
 *   - POST /api/yt/tracks  — scrapes YouTube playlist/video tracks, no API key
 *   - GET  /api/yt/embed-check — detects embed-blocked videos via oEmbed
 *   - resolveYouTube now returns embedBlocked flag + nocookie fallback URL
 *   - All resolvers hardened with better error messages
 *   - Native fetch (Node v18+) for server-side HTTP (scraping)
 *   - User-Agent spoofing so YT page scrape actually works
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const multer   = require('multer');
// node-fetch not needed — Node v18+ has native fetch built in
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase client (server-side only — uses service role key) ───────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '35mb' }));
app.use(express.static(__dirname));

// ─── Multer — memory storage for cloud file uploads ───────────────────────────
// Files land in req.file.buffer; nothing touches disk on the server.
// 20 MB limit mirrors CLOUD_FILE_MAX_BYTES below.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1048576 },   // 20 MB
  fileFilter: (_req, file, cb) => {
    // Accept audio/* and the common container types that browsers may label
    // as application/octet-stream (e.g. .flac, .aiff from some OS pickers)
    const ok = file.mimetype.startsWith('audio/')
      || file.mimetype === 'application/octet-stream'
      || /\.(mp3|flac|aiff?|aac|ogg|opus|wav|m4a|wma|alac)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// Separate multer instance for image uploads (avatars, covers, artist
// avatars/banners). Distinct from `upload` above because the size ceiling
// and accepted mimetypes are completely different from audio — a 20MB
// fileSize limit makes no sense for what should be a compressed profile
// picture, and accepting audio/* here would be wrong in the other direction.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1048576 },   // 5MB — generous for a compressed avatar/banner, not raw camera output
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(png|jpeg|jpg|webp|gif)$/.test(file.mimetype));
  },
});

// ─── Media storage (public bucket: avatars, covers, artist art) ───────────────
// Separate bucket from CLOUD_AUDIO_BUCKET (private, signed-URL audio) — these
// objects are meant to be hot-linked directly as <img src> and in og:image
// meta tags, so the bucket is public and callers get back a plain
// getPublicUrl() string, never a signed URL needing re-resolution.
const MEDIA_BUCKET = 'media';

// One small helper reused by all four image-upload routes (profile avatar,
// profile cover, artist avatar, artist banner) rather than four near-copies
// of the same upload+getPublicUrl dance. `pathPrefix` namespaces objects
// within the single shared bucket (avatars/, covers/, artist-avatars/,
// artist-banners/) so nothing else needs its own bucket later.
async function uploadMediaImage(file, pathPrefix, id) {
  const ext = (file.mimetype.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const objectPath = `${pathPrefix}/${id}.${ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(objectPath, file.buffer, {
    contentType: file.mimetype,
    upsert: true, // overwrite on re-upload — one avatar/banner per id, no versioning needed
  });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

// JS-side mirror of the Postgres slugify() function used in the artists
// migration — needed here so /api/artists/create can predict/generate a
// slug for a brand-new artist row without a round-trip just to read back
// what the DB-side default would have produced (there is no DB-side
// default; the column is NOT NULL with no default, by design, so every
// insert path must supply one explicitly).
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Generates a unique slug by suffixing -2, -3, ... on collision. Small
// number of round-trips in the worst case (one per existing collision),
// acceptable because artist creation is a rare, user-initiated action, not
// a hot path like dbResolveArtist's per-play resolution.
async function dbGenerateUniqueArtistSlug(name) {
  const base = slugify(name) || 'artist';
  let candidate = base;
  let n = 2;
  while (true) {
    const { data } = await supabase.from('artists').select('id').eq('slug', candidate).maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${n++}`;
  }
}

// ─── Supabase DB helpers ──────────────────────────────────────────────────────
// All auth state now lives in Supabase. No local file, no in-memory Maps.

async function dbGetAccount(username) {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('username', username)
    .single();
  if (error && error.code !== 'PGRST116') console.error('[db] getAccount:', error.message);
  return data || null;
}

async function dbCreateAccount(username, displayName, salt, hash) {
  const { error } = await supabase.from('accounts').insert({
    username, display_name: displayName, salt, hash, created_at: new Date().toISOString()
  });
  if (error) throw new Error(error.message);
}

// ─── Profiles (public-facing, deliberately separate from accounts) ───────────
// accounts holds salt/hash — credential material that must never be
// reachable via a "get public profile" code path. profiles holds only what's
// safe to show a stranger, so a careless select('*') here can't ever leak a
// password hash, today or after any future refactor.

// Creates a profile row at signup, public by default, seeded with the same
// display name the account starts with. This now THROWS on failure rather
// than logging and continuing — a previous version treated this as
// best-effort ("a missing profile row degrades gracefully"), but in
// practice a missing row doesn't degrade anything gracefully: the account
// works fine for playback/playlists, but silently never appears in Find a
// User or Discovery, and its own visibility/bio toggle has nothing to
// update. That's exactly what happened to one real account before this
// fix — confusing for the user, invisible to them, and only debuggable by
// querying the database directly. Better to fail signup loudly (the
// account row can simply be re-created by signing up again) than succeed
// with a half-broken account that looks fine until someone tries to find it.
async function dbCreateProfile(username, displayName) {
  const { error } = await supabase.from('profiles').insert({
    username, display_name: displayName,
  });
  if (error) throw new Error(error.message);
}

// Idempotent safety net: ensures a profile row exists for `username`,
// creating one with sane defaults if it's missing. Called on every signin
// (cheap — one indexed SELECT in the common case where the row already
// exists) so that if dbCreateProfile's signup-time throw is ever somehow
// bypassed, or a profile row is lost some other way in the future, the
// account self-heals on next login rather than staying invisible until
// someone notices and runs a manual SQL backfill.
async function dbEnsureProfile(username, displayName) {
  const existing = await dbGetProfile(username);
  if (existing) return;
  try {
    await dbCreateProfile(username, displayName);
    console.log(`[db] ensureProfile: backfilled missing profile row for ${username}`);
  } catch (err) {
    // Don't block signin over this — log loudly so it's noticed, but a
    // signin must still succeed even if the backfill attempt itself fails.
    console.error(`[db] ensureProfile: failed to backfill profile for ${username}:`, err.message);
  }
}

async function dbGetProfile(username) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username)
    .single();
  if (error && error.code !== 'PGRST116') console.error('[db] getProfile:', error.message);
  return data || null;
}

// Partial update — only fields present in `patch` are touched. Used by
// PATCH /api/profiles/me so the client can send just { bio } or just
// { isPublic } without clobbering the rest of the row.
async function dbUpdateProfile(username, patch) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('username', username)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ─── Follows ──────────────────────────────────────────────────────────────────
// follower_count/following_count on `profiles` are maintained by a Postgres
// trigger (trg_follow_counts) on every insert/delete here — never count(*)
// live from the server, the trigger already keeps profiles in sync.

// Returns true on a new follow, false if the follow already existed (treated
// as a harmless no-op by the route, not an error — clicking "follow" twice
// shouldn't surface a failure to the user).
async function dbFollowUser(followerUsername, followedUsername) {
  const { error } = await supabase.from('follows').insert({
    follower_username: followerUsername, followed_username: followedUsername,
  });
  if (error) {
    if (error.code === '23505') return false; // unique violation — already following
    throw new Error(error.message);
  }
  return true;
}

async function dbUnfollowUser(followerUsername, followedUsername) {
  const { error } = await supabase.from('follows')
    .delete()
    .eq('follower_username', followerUsername)
    .eq('followed_username', followedUsername);
  if (error) throw new Error(error.message);
}

async function dbIsFollowing(followerUsername, followedUsername) {
  const { data, error } = await supabase.from('follows')
    .select('follower_username')
    .eq('follower_username', followerUsername)
    .eq('followed_username', followedUsername)
    .maybeSingle();
  if (error) { console.error('[db] isFollowing:', error.message); return false; }
  return !!data;
}

// Paginated list of usernames following / followed by `username`, joined
// against profiles for display data. Simple offset pagination — follower
// lists don't grow anywhere near the size where keyset pagination's extra
// complexity would pay for itself at this app's scale.
//
// is_public is filtered IN THE QUERY (via the !inner embed hint), not after
// the fetch — filtering post-fetch would paginate over the unfiltered join
// and then trim the page down, which desyncs `offset` from what the caller
// thinks they've paged through (a page of 50 could come back with only a
// handful of public rows, and "load more" would skip or re-show users
// depending on where private accounts happened to fall in the order).
async function dbGetFollowers(username, { limit = 50, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from('follows')
    .select('follower_username, created_at, profiles:follower_username!inner(username, display_name, bio, is_public)')
    .eq('followed_username', username)
    .eq('profiles.is_public', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) { console.error('[db] getFollowers:', error.message); return []; }
  return (data || []).map(r => r.profiles).filter(Boolean);
}

async function dbGetFollowing(username, { limit = 50, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from('follows')
    .select('followed_username, created_at, profiles:followed_username!inner(username, display_name, bio, is_public)')
    .eq('follower_username', username)
    .eq('profiles.is_public', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) { console.error('[db] getFollowing:', error.message); return []; }
  return (data || []).map(r => r.profiles).filter(Boolean);
}

// ─── Playlists v2 (relational — for Public/Shared Playlists) ─────────────────
// `playlists_v2` + `playlist_tracks` already exist in the live schema with
// RLS read policies in place (public playlists + their tracks are
// SELECT-able by anyone; everything else is default-deny, bypassed here via
// the service role key same as every other table in this file). No write
// policies exist by design — every write goes through these helpers, never
// directly from the client.
//
// `track_data` stores the resolved track shape verbatim (the same
// { platform, type, embedUrl, id, title, ... } object your resolvers
// already produce) rather than a foreign key into a canonical tracks
// table. Deliberate scope cut: a canonical tracks table buys cross-
// playlist dedup and play counting, neither of which Public/Shared
// Playlists need. Revisit only if/when Charts needs to count plays across
// duplicate adds of the same track in different playlists.

async function dbCreatePlaylist(owner, { name, description, isPublic = false }) {
  const { data, error } = await supabase
    .from('playlists_v2')
    .insert({ owner, name, description: description || null, is_public: !!isPublic })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function dbGetPlaylist(id) {
  const { data, error } = await supabase
    .from('playlists_v2')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) { console.error('[db] getPlaylist:', error.message); return null; }
  return data;
}

// Ownership-scoped update — filters by owner IN the query itself, never
// "fetch then check .owner === username in JS", matching the cloud_files
// discipline. Returns null if no row matched, which the caller treats as
// "not found or not yours" — same 404-not-403 logic as profiles, so a
// forged id in the URL can't be used to probe whether a playlist exists.
async function dbUpdatePlaylistMeta(id, owner, patch) {
  const { data, error } = await supabase
    .from('playlists_v2')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('owner', owner)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function dbDeletePlaylist(id, owner) {
  const { error } = await supabase
    .from('playlists_v2')
    .delete()
    .eq('id', id)
    .eq('owner', owner);
  if (error) throw new Error(error.message);
}

async function dbGetUserPlaylists(owner, { onlyPublic = false } = {}) {
  let q = supabase.from('playlists_v2').select('*').eq('owner', owner).order('updated_at', { ascending: false });
  if (onlyPublic) q = q.eq('is_public', true);
  const { data, error } = await q;
  if (error) { console.error('[db] getUserPlaylists:', error.message); return []; }
  return data || [];
}

async function dbGetPlaylistTracks(playlistId) {
  const { data, error } = await supabase
    .from('playlist_tracks')
    .select('id, position, track_data, added_by, added_at')
    .eq('playlist_id', playlistId)
    .order('position', { ascending: true });
  if (error) { console.error('[db] getPlaylistTracks:', error.message); return []; }
  return data || [];
}

// track_count is maintained here in application code, not via a Postgres
// trigger (unlike profiles.follower_count) — fine at this scale, but means
// any future bulk-import path that writes to playlist_tracks directly
// (bypassing this helper) will cause track_count to drift. Flagging as a
// conscious tradeoff rather than something to silently fix later.
async function dbAddTrackToPlaylist(playlistId, owner, trackData, addedBy) {
  const { count } = await supabase
    .from('playlist_tracks')
    .select('id', { count: 'exact', head: true })
    .eq('playlist_id', playlistId);
  const nextPosition = count || 0;

  const { data, error } = await supabase
    .from('playlist_tracks')
    .insert({ playlist_id: playlistId, position: nextPosition, track_data: trackData, added_by: addedBy })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await supabase.from('playlists_v2')
    .update({ track_count: nextPosition + 1, updated_at: new Date().toISOString() })
    .eq('id', playlistId).eq('owner', owner);
  return data;
}

async function dbRemoveTrackFromPlaylist(playlistId, owner, trackRowId) {
  const { error } = await supabase
    .from('playlist_tracks')
    .delete()
    .eq('id', trackRowId)
    .eq('playlist_id', playlistId);
  if (error) throw new Error(error.message);

  const { count } = await supabase
    .from('playlist_tracks')
    .select('id', { count: 'exact', head: true })
    .eq('playlist_id', playlistId);
  await supabase.from('playlists_v2')
    .update({ track_count: count || 0, updated_at: new Date().toISOString() })
    .eq('id', playlistId).eq('owner', owner);
}

// Public playlists belonging to `username` — for the public profile viewer.
// No private playlists are ever returned by this helper, regardless of who
// is asking, since it's used by an endpoint with no concept of "viewing
// your own profile" auth bypass (that's `dbGetUserPlaylists` without
// onlyPublic, used only by the owner's own /api/playlists/mine route).
async function dbGetPublicPlaylistsForUser(username) {
  return dbGetUserPlaylists(username, { onlyPublic: true });
}

// ─── Playlist Likes ─────────────────────────────────────────────────────────
// playlist_likes is a pure join table (playlist_id, username) — no RLS write
// policies, same as playlist_tracks/playlists_v2; every write goes through
// these helpers via the service role. like_count on playlists_v2 is
// maintained here in application code rather than a trigger, matching the
// existing track_count tradeoff exactly (see comment above dbAddTrackToPlaylist).
//
// Liking is idempotent at the route level (liking an already-liked playlist
// is a no-op success, not an error) so the frontend heart button never has
// to track local "did I already like this" state before firing the request.

async function dbLikePlaylist(playlistId, username) {
  // Upsert avoids a duplicate-key error on double-click / multi-tab races;
  // ignoreDuplicates means a second insert of the same pair is silently a
  // no-op rather than an error, and below we only bump like_count when a
  // row was actually inserted (not on the no-op branch).
  const { data, error } = await supabase
    .from('playlist_likes')
    .upsert({ playlist_id: playlistId, username }, { onConflict: 'playlist_id,username', ignoreDuplicates: true })
    .select();
  if (error) throw new Error(error.message);
  const inserted = (data || []).length > 0;
  if (inserted) {
    const { count } = await supabase
      .from('playlist_likes')
      .select('username', { count: 'exact', head: true })
      .eq('playlist_id', playlistId);
    await supabase.from('playlists_v2').update({ like_count: count || 0 }).eq('id', playlistId);
    return count || 0;
  }
  // Already liked — return the current count without re-counting needlessly.
  const pl = await dbGetPlaylist(playlistId);
  return pl ? pl.like_count : 0;
}

async function dbUnlikePlaylist(playlistId, username) {
  const { error } = await supabase
    .from('playlist_likes')
    .delete()
    .eq('playlist_id', playlistId)
    .eq('username', username);
  if (error) throw new Error(error.message);
  const { count } = await supabase
    .from('playlist_likes')
    .select('username', { count: 'exact', head: true })
    .eq('playlist_id', playlistId);
  await supabase.from('playlists_v2').update({ like_count: count || 0 }).eq('id', playlistId);
  return count || 0;
}

async function dbHasLiked(playlistId, username) {
  if (!username) return false;
  const { data, error } = await supabase
    .from('playlist_likes')
    .select('playlist_id')
    .eq('playlist_id', playlistId)
    .eq('username', username)
    .maybeSingle();
  if (error) { console.error('[db] hasLiked:', error.message); return false; }
  return !!data;
}

// Playlists `username` has liked — for the Liked Playlists panel.
// Joins through to playlists_v2 and filters out anything that's gone
// private or been deleted since the like was made, same defensive pattern
// as dbGetSharedWithMe filtering out playlists_v2-null rows.
async function dbGetLikedPlaylists(username) {
  const { data, error } = await supabase
    .from('playlist_likes')
    .select('created_at, playlists_v2(id, name, description, is_public, track_count, like_count, owner)')
    .eq('username', username)
    .order('created_at', { ascending: false });
  if (error) { console.error('[db] getLikedPlaylists:', error.message); return []; }
  return (data || [])
    .filter(r => r.playlists_v2 && r.playlists_v2.is_public)
    .map(r => ({
      likedAt: r.created_at,
      id: r.playlists_v2.id, name: r.playlists_v2.name,
      description: r.playlists_v2.description,
      trackCount: r.playlists_v2.track_count,
      likeCount: r.playlists_v2.like_count,
      owner: r.playlists_v2.owner,
      updatedAt: r.playlists_v2.updated_at,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ARTISTS
// ═══════════════════════════════════════════════════════════════════════════════
// An artist is EITHER an auto-created metadata row (account_id NULL — exists
// purely because tracks with that artist name have been played/uploaded; no
// one can sign in as it, its page is read-only to everyone) OR a claimed row
// (account_id set — a real FREQ account owns it and can edit name/bio/
// avatar/banner). Both are the exact same row shape and go through the exact
// same API — claiming is just an UPDATE, never a data migration. See the
// migration comments on the `artists` table for the full reasoning.
//
// normalizeArtistName is the dedup key generator: lowercase, trim, collapse
// internal whitespace, strip a leading "the " and trailing "(official)"/
// "- topic" noise that's common in scraped/ID3 metadata. This intentionally
// stays simple (no fuzzy/Levenshtein matching) — exact-after-normalization
// is the right tradeoff for now: it merges "Drake" / "drake " / "DRAKE"
// without any risk of merging two actually-different artists who happen to
// have similar names, which a fuzzy matcher could do silently and
// incorrectly.
function normalizeArtistName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^the\s+/, '');
  s = s.replace(/\s*-\s*topic$/, '');       // YouTube auto-generated "Artist - Topic" channels
  s = s.replace(/\s*\(official\)$/, '');
  s = s.trim();
  return s || null;
}

// Resolves an artist name to an artists.id, creating an unclaimed row if no
// existing artist (claimed or not) matches the normalized name. Read-first,
// same shape as dbGetOrCreateTrack just above this for the identical reason:
// this runs on every play that carries an artist name, so the common case
// (artist already exists) should cost one SELECT, not an upsert.
//
// Ties to a CLAIMED artist take priority over creating a new unclaimed row
// when both could match — in practice this only matters once claiming
// exists at all, but the query order (search all artists by
// normalized_name, not just unclaimed ones) means a claimed artist always
// "wins" their own name without any special-case code needed here.
async function dbResolveArtist(rawName) {
  const normalized = normalizeArtistName(rawName);
  if (!normalized) return null;

  const { data: existing } = await supabase
    .from('artists').select('id').eq('normalized_name', normalized).limit(1).maybeSingle();
  if (existing) return existing.id;

  // Plain insert + catch-the-unique-violation, NOT .upsert() — the
  // uniqueness guarantee here lives on a PARTIAL index
  // (idx_artists_normalized_name_unclaimed, WHERE account_id IS NULL), and
  // supabase-js's upsert() onConflict target can't express a WHERE clause,
  // so it can't target a partial index at all. A plain insert naturally
  // hits that same partial index's constraint and raises 23505 on conflict,
  // which is the same race-handling shape dbFollowUser already uses below
  // for an ordinary (non-partial) unique constraint.
  //
  // slug is NOT NULL + unique on `artists`, so every insert path (auto-
  // created here from a play, or explicit via /api/artists/create) must
  // generate one up front — there's no DB-side default to fall back on.
  const slug = await dbGenerateUniqueArtistSlug(rawName);
  const { data, error } = await supabase
    .from('artists')
    .insert({ name: rawName.trim(), normalized_name: normalized, slug })
    .select('id')
    .single();
  if (!error) {
    // No need to insert into artist_stats here — trg_seed_artist_stats
    // (AFTER INSERT on artists) already created that row atomically as
    // part of the insert above. An earlier version of this function
    // duplicated that insert manually, which meant every single new-artist
    // creation silently threw and discarded a primary-key-violation error
    // on a redundant round-trip. Removed rather than left as dead code.
    return data.id;
  }
  if (error.code !== '23505') { console.error('[db] resolveArtist:', error.message); return null; }
  // Lost the race to a concurrent request creating the same artist —
  // re-select rather than treat this as a failure.
  const { data: row2 } = await supabase
    .from('artists').select('id').eq('normalized_name', normalized).maybeSingle();
  return row2 ? row2.id : null;
}

async function dbGetArtist(idOrAccountUsername) {
  // Accepts either an artists.id (uuid) or, for the "view my own claimed
  // artist page" convenience case, an account username — callers that
  // already know which they have should prefer the more specific
  // dbGetArtistById/dbGetArtistByAccount below; this exists for the route
  // layer where a single :id path param could plausibly be either in a
  // future "vanity URL" sense. Today it's only ever called with a uuid.
  return dbGetArtistById(idOrAccountUsername);
}

async function dbGetArtistById(id) {
  const { data, error } = await supabase.from('artists').select('*').eq('id', id).maybeSingle();
  if (error) { console.error('[db] getArtistById:', error.message); return null; }
  return data;
}

async function dbGetArtistByAccount(username) {
  const { data, error } = await supabase.from('artists').select('*').eq('account_id', username).maybeSingle();
  if (error) { console.error('[db] getArtistByAccount:', error.message); return null; }
  return data;
}

async function dbGetArtistBySlug(slug) {
  const { data, error } = await supabase.from('artists').select('*').eq('slug', slug).maybeSingle();
  if (error) { console.error('[db] getArtistBySlug:', error.message); return null; }
  return data;
}

async function dbGetArtistStats(artistId) {
  const { data, error } = await supabase.from('artist_stats').select('*').eq('artist_id', artistId).maybeSingle();
  if (error) { console.error('[db] getArtistStats:', error.message); return null; }
  return data;
}

async function dbGetLiveArtistStats(artistId, cachedStats = null) {
  // NOTE: intentionally NOT filtered by is_published. play_count/play_count_7d
  // accrue on a track from the moment it's first played, which can happen
  // before the artist ever runs it through the publish flow (e.g. it was
  // played as a plain external-URL track, or as an unpublished upload via
  // direct link). recomputeArtistStats (the cron that seeds artist_stats)
  // sums ALL of an artist's tracks for exactly this reason. This function
  // used to filter to is_published=true here, which silently undercounted
  // — sometimes to zero — for any artist whose plays sat mostly on
  // not-yet-published tracks, even though the real totals (visible in
  // artist_stats / recomputeArtistStats) were correct all along. Matching
  // that same "count everything" logic here is what actually fixes it,
  // rather than just falling back to a cached number when this query
  // happens to look low.
  const [followerResult, trackRowsResult, monthlyRowsResult] = await Promise.all([
    supabase.from('artist_followers')
      .select('*', { count: 'exact', head: true })
      .eq('artist_id', artistId),
    supabase.from('tracks')
      .select('play_count, play_count_7d')
      .eq('artist_id', artistId),
    supabase.from('track_plays')
      .select('username, tracks!inner(artist_id)')
      .eq('tracks.artist_id', artistId)
      .gte('played_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .not('username', 'is', null),
  ]);

  if (followerResult.error) console.error('[db] liveArtistStats followers:', followerResult.error.message);
  if (trackRowsResult.error) console.error('[db] liveArtistStats tracks:', trackRowsResult.error.message);
  if (monthlyRowsResult.error) console.error('[db] liveArtistStats listeners:', monthlyRowsResult.error.message);

  const tracks = trackRowsResult.data || [];
  const listenerNames = new Set((monthlyRowsResult.data || []).map(r => r.username).filter(Boolean));
  const totalPlays = tracks.reduce((sum, t) => sum + (Number(t.play_count) || 0), 0);
  const totalPlays7d = tracks.reduce((sum, t) => sum + (Number(t.play_count_7d) || 0), 0);

  return {
    followerCount: followerResult.count || 0,
    totalPlays,
    totalPlays7d,
    monthlyListeners: listenerNames.size,
    totalLikesReceived: Number(cachedStats?.total_likes_received) || 0,
    chartRank: cachedStats?.chart_rank ?? null,
    chartRankPrev: cachedStats?.chart_rank_prev ?? null,
  };
}

// Paginated artist directory — GET /api/artists. Default sort is
// follower_count since that's the most legible "who matters here" signal
// without requiring a join into artist_stats for the common listing case;
// sort=trending joins artist_stats for total_plays_7d instead.
async function dbListArtists({ sort = 'followers', limit = 30, offset = 0, search = null } = {}) {
  if (sort === 'trending') {
    const { data, error } = await supabase
      .from('artist_stats')
      .select('artist_id, total_plays_7d, artists!inner(*)')
      .order('total_plays_7d', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) { console.error('[db] listArtists trending:', error.message); return []; }
    return (data || []).map(r => r.artists);
  }
  let q = supabase.from('artists').select('*');
  if (search) q = q.ilike('name', `%${search}%`);
  q = sort === 'recent' ? q.order('created_at', { ascending: false }) : q.order('follower_count', { ascending: false });
  const { data, error } = await q.range(offset, offset + limit - 1);
  if (error) { console.error('[db] listArtists:', error.message); return []; }
  return data || [];
}

async function dbUpdateArtist(artistId, patch) {
  const { data, error } = await supabase
    .from('artists').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', artistId).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ── Artist tracks (top tracks / most liked / trending) ─────────────────────
// "Most liked tracks" is intentionally NOT wired to a real number yet — see
// the artist_stats migration comment: FREQ has playlist likes, not
// per-track likes, so there is no honest source for this today. Rather than
// fabricate a number, likeCount is always 0 here until a track-like feature
// ships; the field exists in the response shape now so the frontend/API
// contract doesn't change later, only the value starts becoming real.
async function dbGetArtistTracks(artistId, { sort = 'plays', limit = 20 } = {}) {
  const col = sort === 'trending' ? 'play_count_7d' : 'play_count';
  const { data, error } = await supabase
    .from('tracks')
    .select('id, original_url, platform, title, play_count, play_count_7d, last_played_at, cover_url, cloud_file_id, published_at, like_count, is_explicit')
    .eq('artist_id', artistId)
    .eq('is_published', true)
    .order(col, { ascending: false })
    .limit(limit);
  if (error) { console.error('[db] getArtistTracks:', error.message); return []; }
  return data || [];
}

// ── Artist follows ──────────────────────────────────────────────────────────
// Mirrors dbFollowUser/dbUnfollowUser/dbIsFollowing exactly, just against
// artist_followers instead of follows. follower_count itself is maintained
// by the trg_artist_follower_counts trigger (see migration), not here — these
// helpers only ever touch artist_followers; nothing here writes to
// artists.follower_count directly, by design, so there's exactly one place
// that number can be wrong: the trigger, not N call sites.
async function dbFollowArtist(followerUsername, artistId) {
  const { error } = await supabase.from('artist_followers').insert({
    artist_id: artistId, follower_username: followerUsername,
  });
  if (error) {
    if (error.code === '23505') return false; // already following
    throw new Error(error.message);
  }
  // Safety-net recount in case the trigger is missing or lagging —
  // counts actual rows rather than relying purely on the trigger path.
  const { count } = await supabase.from('artist_followers')
    .select('*', { count: 'exact', head: true }).eq('artist_id', artistId);
  if (count != null) {
    await supabase.from('artists').update({ follower_count: count }).eq('id', artistId);
  }
  return true;
}

async function dbUnfollowArtist(followerUsername, artistId) {
  const { error } = await supabase.from('artist_followers')
    .delete().eq('artist_id', artistId).eq('follower_username', followerUsername);
  if (error) throw new Error(error.message);
  // Safety-net recount
  const { count } = await supabase.from('artist_followers')
    .select('*', { count: 'exact', head: true }).eq('artist_id', artistId);
  if (count != null) {
    await supabase.from('artists').update({ follower_count: count }).eq('id', artistId);
  }
}

async function dbIsFollowingArtist(followerUsername, artistId) {
  const { data, error } = await supabase.from('artist_followers')
    .select('artist_id').eq('artist_id', artistId).eq('follower_username', followerUsername).maybeSingle();
  if (error) { console.error('[db] isFollowingArtist:', error.message); return false; }
  return !!data;
}

// ── Artist releases (discography) ───────────────────────────────────────────
async function dbGetArtistReleases(artistId, { type = null, includeNonPublic = false } = {}) {
  let q = supabase.from('artist_releases').select('*').eq('artist_id', artistId);
  if (type) q = q.eq('release_type', type);
  // Visitors only see public releases; owner dashboard passes includeNonPublic:true
  if (!includeNonPublic) q = q.eq('visibility', 'public');
  const { data, error } = await q.order('release_date', { ascending: false, nullsFirst: false });
  if (error) { console.error('[db] getArtistReleases:', error.message); return []; }
  return data || [];
}

async function dbCreateRelease(artistId, { title, releaseType, coverUrl, releaseDate, visibility = 'public' }) {
  const safeVisibility = ['public', 'private', 'unlisted'].includes(visibility) ? visibility : 'public';
  const safeType = ['single', 'ep', 'album', 'mixtape', 'compilation'].includes(releaseType) ? releaseType : 'single';
  const { data, error } = await supabase.from('artist_releases').insert({
    artist_id: artistId, title, release_type: safeType,
    cover_url: coverUrl || null, release_date: releaseDate || null,
    visibility: safeVisibility,
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// Adds a track to a release at the next position, then refreshes the
// release's track_count — same maintained-in-app-code pattern as
// dbAddTrackToPlaylist's track_count, for the same reason (no trigger
// justified for a count this simple, see that function's comment).
async function dbAddTrackToRelease(releaseId, trackId) {
  const { count } = await supabase
    .from('artist_release_tracks').select('id', { count: 'exact', head: true }).eq('release_id', releaseId);
  const position = count || 0;
  const { error } = await supabase.from('artist_release_tracks').insert({
    release_id: releaseId, track_id: trackId, position,
  });
  if (error) throw new Error(error.message);
  await supabase.from('artist_releases').update({ track_count: position + 1, updated_at: new Date().toISOString() }).eq('id', releaseId);
}

// Deletes the release row itself. artist_release_tracks rows pointing at it
// cascade-delete via their release_id FK (ON DELETE CASCADE — see migration),
// which only removes the *junction* rows, not the underlying tracks — a
// deleted release un-links its tracks back to standalone published tracks
// rather than deleting the music itself. That's deliberate: removing a
// release (e.g. an EP) shouldn't silently delete songs an artist still
// wants live on their page as standalone tracks.
async function dbDeleteRelease(releaseId) {
  const { error } = await supabase.from('artist_releases').delete().eq('id', releaseId);
  if (error) throw new Error(error.message);
}

// Partial update for release metadata — title, cover_url, release_date, and
// description are the only mutable fields. release_type is intentionally NOT
// patchable after creation (changing "Album" to "EP" post-hoc is confusing
// and rarely correct; delete + recreate is the right escape hatch for that).
async function dbUpdateRelease(releaseId, patch) {
  // Guard visibility against invalid values
  if (patch.visibility !== undefined) {
    patch.visibility = ['public', 'private', 'unlisted'].includes(patch.visibility)
      ? patch.visibility : 'public';
  }
  const { data, error } = await supabase
    .from('artist_releases')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', releaseId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Removes a single track from a release (junction row only — the track itself
// is not deleted). Recounts track_count after removal.
async function dbRemoveTrackFromRelease(releaseId, trackId) {
  const { error } = await supabase
    .from('artist_release_tracks')
    .delete()
    .eq('release_id', releaseId)
    .eq('track_id', trackId);
  if (error) throw new Error(error.message);
  const { count } = await supabase
    .from('artist_release_tracks')
    .select('id', { count: 'exact', head: true })
    .eq('release_id', releaseId);
  await supabase.from('artist_releases')
    .update({ track_count: count || 0, updated_at: new Date().toISOString() })
    .eq('id', releaseId);
}

async function dbGetReleaseTracks(releaseId) {
  const { data, error } = await supabase
    .from('artist_release_tracks')
    .select('position, tracks(id, original_url, platform, title, play_count, cover_url, cloud_file_id, artist_id, artist_name)')
    .eq('release_id', releaseId)
    .order('position', { ascending: true });
  if (error) { console.error('[db] getReleaseTracks:', error.message); return []; }
  return (data || []).filter(r => r.tracks).map(r => ({ ...r.tracks, position: r.position }));
}

// ── Track Lyrics ────────────────────────────────────────────────────────────
async function dbGetTrackLyrics(trackId) {
  const { data, error } = await supabase
    .from('track_lyrics').select('*').eq('track_id', trackId).maybeSingle();
  if (error) { console.error('[db] getTrackLyrics:', error.message); return null; }
  return data;
}

async function dbUpsertTrackLyrics(trackId, lyrics) {
  const { data, error } = await supabase
    .from('track_lyrics')
    .upsert({ track_id: trackId, lyrics, updated_at: new Date().toISOString() }, { onConflict: 'track_id' })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function dbDeleteTrackLyrics(trackId) {
  const { error } = await supabase.from('track_lyrics').delete().eq('track_id', trackId);
  if (error) throw new Error(error.message);
}

// ── Artist collaborations (Featured/Collaborator/Producer/Contributor) ─────
// XOR check (exactly one of track_id/release_id is set per row) — see
// migration create_artist_collaborations. collaborator_artist_id always
// points at an artists row regardless of whether that artist page has been
// claimed by an account, so an unclaimed/placeholder artist (e.g. a
// producer who hasn't signed up yet) can still be credited.
const COLLAB_ROLES = ['featured', 'collaborator', 'producer', 'contributor'];

// Shared select shape for both track and release collaborator lookups — the
// joined artists row gives the frontend everything it needs to render a
// credit (name/slug/avatar) without a second round trip per collaborator.
const COLLAB_SELECT = 'id, role, track_id, release_id, collaborator_artist_id, added_by, created_at, ' +
  'artists:collaborator_artist_id(id, name, slug, avatar_url, is_verified)';

async function dbGetTrackCollaborators(trackId) {
  const { data, error } = await supabase
    .from('artist_collaborations')
    .select(COLLAB_SELECT)
    .eq('track_id', trackId)
    .order('role', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) { console.error('[db] getTrackCollaborators:', error.message); return []; }
  return data || [];
}

async function dbGetReleaseCollaborators(releaseId) {
  const { data, error } = await supabase
    .from('artist_collaborations')
    .select(COLLAB_SELECT)
    .eq('release_id', releaseId)
    .order('role', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) { console.error('[db] getReleaseCollaborators:', error.message); return []; }
  return data || [];
}

// Batch lookup used by track-list endpoints (top tracks, search results) so
// rendering N tracks with their collaborator credits costs one query, not N.
// Returns a Map keyed by track_id -> array of collaborator rows.
async function dbGetCollaboratorsForTracks(trackIds) {
  if (!trackIds || !trackIds.length) return new Map();
  const { data, error } = await supabase
    .from('artist_collaborations')
    .select(COLLAB_SELECT)
    .in('track_id', trackIds)
    .order('role', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) { console.error('[db] getCollaboratorsForTracks:', error.message); return new Map(); }
  const map = new Map();
  for (const row of data || []) {
    if (!map.has(row.track_id)) map.set(row.track_id, []);
    map.get(row.track_id).push(row);
  }
  return map;
}

// addedByUsername is captured for audit purposes (artist_collaborations.added_by)
// — it's always the session username of whoever called the route, which the
// route handler has already verified owns the track/release being credited.
async function dbAddCollaborator({ trackId = null, releaseId = null, collaboratorArtistId, role, addedByUsername }) {
  const { data, error } = await supabase
    .from('artist_collaborations')
    .insert({
      track_id: trackId, release_id: releaseId,
      collaborator_artist_id: collaboratorArtistId, role,
      added_by: addedByUsername || null,
    })
    .select(COLLAB_SELECT)
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('That artist already has this role on this item.');
    throw new Error(error.message);
  }
  return data;
}

async function dbRemoveCollaboration(collaborationId) {
  const { error } = await supabase.from('artist_collaborations').delete().eq('id', collaborationId);
  if (error) throw new Error(error.message);
}

async function dbGetCollaboration(collaborationId) {
  const { data, error } = await supabase
    .from('artist_collaborations').select('*').eq('id', collaborationId).maybeSingle();
  if (error) { console.error('[db] getCollaboration:', error.message); return null; }
  return data;
}

// Shapes a raw artist_collaborations row (with its joined artists row) into
// the flat credit object every API response below sends to the frontend.
function shapeCollaborator(row) {
  return {
    id: row.id,
    role: row.role,
    artistId: row.collaborator_artist_id,
    name: row.artists?.name || 'Unknown Artist',
    slug: row.artists?.slug || null,
    avatarUrl: row.artists?.avatar_url || null,
    isVerified: !!row.artists?.is_verified,
  };
}

// ── Periodic recompute: artist_stats + release rollups + artist chart rank ──
// Same philosophy as recomputeWeeklyPlayCounts: aggregate queries that don't
// need per-request freshness run on a timer instead of on every page view.
// Three things happen per pass:
//   1. total_plays / total_plays_7d per artist — summed from tracks, the
//      table that already carries both numbers per-track.
//   2. monthly_listeners — distinct usernames in track_plays over the
//      trailing 30 days, joined through tracks.artist_id. Anonymous plays
//      (username IS NULL) are correctly excluded — "listeners" means
//      identifiable people, an anonymous play has no listener to count.
//   3. chart_rank — every artist ranked by total_plays_7d descending;
//      chart_rank_prev is set to whatever chart_rank WAS before this pass
//      overwrites it, which is what makes "weekly movement" computable
//      (chart_rank_prev - chart_rank: positive = climbed, negative = fell).
async function recomputeArtistStats() {
  try {
    const { data: artists, error: artistsErr } = await supabase.from('artists').select('id, account_id');
    if (artistsErr) { console.error('[artists] recompute fetch artists:', artistsErr.message); return; }
    if (!artists || !artists.length) return;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Pull every artist's track totals in one query rather than N queries —
    // important here specifically because this job's cost scales with
    // artist count, unlike recomputeWeeklyPlayCounts which scales with
    // track count and was already doing this.
    const { data: trackRows, error: tracksErr } = await supabase
      .from('tracks').select('artist_id, play_count, play_count_7d').not('artist_id', 'is', null);
    if (tracksErr) { console.error('[artists] recompute fetch tracks:', tracksErr.message); return; }

    const totals = new Map(); // artist_id -> { plays, plays7d }
    for (const t of trackRows || []) {
      const cur = totals.get(t.artist_id) || { plays: 0, plays7d: 0 };
      cur.plays += t.play_count || 0;
      cur.plays7d += t.play_count_7d || 0;
      totals.set(t.artist_id, cur);
    }

    // Monthly listeners: distinct (artist_id, username) pairs from plays in
    // the last 30 days, joined through tracks. One query, grouped client-side
    // (Supabase's JS client has no GROUP BY; for this table's realistic size
    // — thousands, not millions, of rows per month — pulling raw rows and
    // reducing in Node is simpler and fast enough, the same tradeoff already
    // made in recomputeWeeklyPlayCounts).
    const { data: playRows, error: playsErr } = await supabase
      .from('track_plays')
      .select('username, tracks!inner(artist_id)')
      .gte('played_at', thirtyDaysAgo)
      .not('username', 'is', null);
    if (playsErr) { console.error('[artists] recompute fetch plays:', playsErr.message); return; }

    const listenerSets = new Map(); // artist_id -> Set(username)
    for (const p of playRows || []) {
      const aid = p.tracks?.artist_id;
      if (!aid) continue;
      if (!listenerSets.has(aid)) listenerSets.set(aid, new Set());
      listenerSets.get(aid).add(p.username);
    }

    // Rank by total_plays_7d desc for chart_rank. Artists with zero plays
    // get NULL rank (unranked), not a rank at the bottom of an arbitrary
    // tie-break order — "unranked" is a more honest state than "last place"
    // for an artist nobody has played yet.
    const ranked = [...totals.entries()]
      .filter(([, t]) => t.plays7d > 0)
      .sort((a, b) => b[1].plays7d - a[1].plays7d);
    const rankByArtist = new Map(ranked.map(([id], i) => [id, i + 1]));

    const { data: prevStats } = await supabase.from('artist_stats').select('artist_id, chart_rank');
    const prevRankByArtist = new Map((prevStats || []).map(r => [r.artist_id, r.chart_rank]));

    for (const artist of artists) {
      const t = totals.get(artist.id) || { plays: 0, plays7d: 0 };
      const monthlyListeners = listenerSets.get(artist.id)?.size || 0;
      const newRank = rankByArtist.get(artist.id) ?? null;
      const prevRank = prevRankByArtist.get(artist.id) ?? null;
      await supabase.from('artist_stats').upsert({
        artist_id: artist.id,
        total_plays: t.plays,
        total_plays_7d: t.plays7d,
        monthly_listeners: monthlyListeners,
        chart_rank: newRank,
        chart_rank_prev: prevRank,
        computed_at: new Date().toISOString(),
      }, { onConflict: 'artist_id' });

      // Write through to profiles.total_plays for claimed artists, so the
      // public profile page's "Total Plays" stat is real, not a separate
      // number that could drift from artist_stats. total_likes_received
      // stays at its existing default (0) here — there's no track-likes
      // table yet (see artist_stats.total_likes_received's own comment),
      // and writing a fabricated number would be worse than an honest 0.
      if (artist.account_id) {
        await supabase.from('profiles')
          .update({ total_plays: t.plays })
          .eq('username', artist.account_id);
      }
    }

    // Release rollups — total_plays per release, summed from the tracks
    // attached to it via artist_release_tracks. This column has existed on
    // artist_releases since the releases schema shipped, and this function's
    // own header comment already claimed to compute "release rollups", but
    // nothing ever actually wrote it — every release sat at a hardcoded 0
    // regardless of how many plays its tracks had. total_likes stays at its
    // existing default for the same reason totalLikesReceived does above:
    // there's no per-track likes table yet, so writing a real total_plays
    // but a fabricated total_likes would be inconsistent with that honesty
    // policy elsewhere in this function.
    const { data: releaseTrackRows, error: relTracksErr } = await supabase
      .from('artist_release_tracks')
      .select('release_id, tracks!inner(play_count)');
    if (relTracksErr) {
      console.error('[artists] recompute fetch release tracks:', relTracksErr.message);
    } else {
      const releasePlays = new Map(); // release_id -> summed play_count
      for (const row of releaseTrackRows || []) {
        const cur = releasePlays.get(row.release_id) || 0;
        releasePlays.set(row.release_id, cur + (row.tracks?.play_count || 0));
      }
      for (const [releaseId, plays] of releasePlays) {
        await supabase.from('artist_releases')
          .update({ total_plays: plays, updated_at: new Date().toISOString() })
          .eq('id', releaseId);
      }
    }
  } catch (err) {
    console.error('[artists] recompute failed:', err);
  }
}
// Same 10-minute cadence as recomputeWeeklyPlayCounts, and for the same
// reason — frequent enough that an artist page or chart feels responsive
// to recent activity without paying this query's cost on every request.
setInterval(recomputeArtistStats, 10 * 60 * 1000);
recomputeArtistStats(); // run once at boot

// Separate rate-limit bucket from followRateLimit (user follows) — an
// artist page realistically gets followed/unfollowed in quick succession
// while someone's browsing a directory of several artists, which is
// different traffic shape than following individual users one at a time.
// Same 30/min ceiling and same session-resolving structure either way.
async function artistFollowRateLimit(req, res, next) {
  const token = req.body?.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  req._followSession = sess;
  if (!sess) return next();
  const key = sess.username;
  const now = Date.now();
  const times = (artistFollowRateLimitHits.get(key) || []).filter(t => now - t < 60_000);
  times.push(now);
  artistFollowRateLimitHits.set(key, times);
  if (times.length > 30) {
    return res.status(429).json({ error: 'Too many follow/unfollow actions. Please slow down.' });
  }
  next();
}
const artistFollowRateLimitHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of artistFollowRateLimitHits) {
    const fresh = times.filter(t => now - t < 60_000);
    if (!fresh.length) artistFollowRateLimitHits.delete(key); else artistFollowRateLimitHits.set(key, fresh);
  }
}, 300_000);

// ─── Community Charts (track plays) ─────────────────────────────────────────
// `tracks` is the first canonical-track table in FREQ — playlist_tracks
// deliberately stores track_data as verbatim jsonb (see the comment above
// dbCreatePlaylist), but ranking the same track across every playlist/queue
// it's ever been started from needs one stable row per track. originalUrl
// is that identity: it's already the frontend's own de-dup key
// (state.queue.some(q => q.originalUrl === item.originalUrl)), so this adds
// no new concept for the client — just a new place that URL gets POSTed.
//
// play_count is maintained in app code exactly like track_count/like_count
// elsewhere in this file. play_count_7d is different: it's a *rolling*
// window, so it can't just be incremented — it has to be recomputed from
// track_plays periodically (see recomputeWeeklyPlayCounts below), since an
// increment-only counter would never decrease as old plays age out of the
// window.

async function dbGetOrCreateTrack(originalUrl, platform, title, artistName) {
  // Try the read path first — this runs on every single play, so the common
  // case (track already exists) should be one SELECT, not an upsert churning
  // the row's defaults every time.
  const { data: existing } = await supabase
    .from('tracks').select('id, artist_id, artist_name').eq('original_url', originalUrl).maybeSingle();
  if (existing) {
    // Backfill artist linkage on a track that was first played before its
    // artist name was available (e.g. an old YouTube-resolved play, then
    // later the same originalUrl shows up again with ID3 data attached —
    // not how this actually happens today since URLs are platform-specific,
    // but cheap correctness insurance for any future source that re-plays
    // the same originalUrl with richer metadata than it had the first time).
    if (!existing.artist_id && artistName) {
      const artistId = await dbResolveArtist(artistName);
      if (artistId) {
        await supabase.from('tracks').update({ artist_id: artistId, artist_name: artistName }).eq('id', existing.id);
      }
    }
    return existing.id;
  }

  const artistId = artistName ? await dbResolveArtist(artistName) : null;
  const { data, error } = await supabase
    .from('tracks')
    .upsert({
      original_url: originalUrl, platform: platform || null, title: title || null,
      artist_name: artistName || null, artist_id: artistId,
    }, { onConflict: 'original_url', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data.id;
  // Lost the upsert race to a concurrent request — the row now exists, just
  // not in `data` because ignoreDuplicates skipped returning it. Re-select.
  const { data: row2 } = await supabase
    .from('tracks').select('id').eq('original_url', originalUrl).maybeSingle();
  return row2 ? row2.id : null;
}

// Per-(track, listener) cooldown so holding play/pause or spamming repeat
// can't farm chart position. Listener key is username when signed in,
// otherwise the caller passes an IP-derived key — either way this is a
// courtesy anti-gaming check, not a security boundary (a determined script
// can rotate keys), which is an acceptable tradeoff for a self-hosted music
// player's "what's popular" list.
const recentPlayKeys = new Map(); // `${trackId}:${listenerKey}` -> last play timestamp
const PLAY_COOLDOWN_MS = 30_000;
setInterval(() => {
  const cutoff = Date.now() - PLAY_COOLDOWN_MS;
  for (const [key, t] of recentPlayKeys) if (t < cutoff) recentPlayKeys.delete(key);
}, 120_000);

async function dbLogPlay(originalUrl, { platform, title, username, listenerKey, artistName }) {
  const trackId = await dbGetOrCreateTrack(originalUrl, platform, title, artistName);
  if (!trackId) return null;

  const cooldownKey = `${trackId}:${listenerKey || username || 'anon'}`;
  const last = recentPlayKeys.get(cooldownKey);
  if (last && Date.now() - last < PLAY_COOLDOWN_MS) {
    return { trackId, counted: false }; // within cooldown — silently skip, not an error
  }
  recentPlayKeys.set(cooldownKey, Date.now());

  await supabase.from('track_plays').insert({ track_id: trackId, username: username || null });

  // Atomic increment via the increment_track_play_count() RPC (see migration)
  // rather than read-count-then-write, which would race under concurrent
  // plays of the same track and silently undercount.
  const { data, error } = await supabase.rpc('increment_track_play_count', {
    p_track_id: trackId, p_title: title || null,
  });
  if (error) { console.error('[db] logPlay increment:', error.message); return { trackId, counted: true }; }
  return { trackId, counted: true, playCount: data };
}

async function dbGetTopTracks({ window = 'all', limit = 50 } = {}) {
  const col = window === '7d' ? 'play_count_7d' : 'play_count';
  const { data, error } = await supabase
    .from('tracks')
    .select('id, original_url, platform, title, play_count, play_count_7d, last_played_at, cover_url, artist_id, artist_name')
    .eq('is_published', true)
    .gt(col, 0)
    .order(col, { ascending: false })
    .order('last_played_at', { ascending: false }) // tiebreak: more recently played ranks higher
    .limit(limit);
  if (error) { console.error('[db] getTopTracks:', error.message); return []; }
  return data || [];
}

// Recompute the rolling 7-day count for every track that's had a play
// recently (and zero out any track that fell out of the window entirely —
// COALESCE handles tracks with no rows in the last 7 days). Run on a timer
// rather than per-request since this is a full aggregate over track_plays
// and doesn't need to be real-time-accurate to the second.
async function recomputeWeeklyPlayCounts() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent, error } = await supabase
      .from('track_plays')
      .select('track_id')
      .gte('played_at', sevenDaysAgo);
    if (error) { console.error('[charts] recompute fetch:', error.message); return; }

    const counts = new Map();
    for (const row of recent || []) counts.set(row.track_id, (counts.get(row.track_id) || 0) + 1);

    // Tracks with recent plays: write their fresh count.
    for (const [trackId, count] of counts) {
      await supabase.from('tracks').update({ play_count_7d: count }).eq('id', trackId);
    }
    // Tracks with a stale nonzero play_count_7d but no plays in the window
    // anymore need to be zeroed, or they'd never leave the Trending chart.
    const { data: stale } = await supabase
      .from('tracks').select('id').gt('play_count_7d', 0);
    for (const row of stale || []) {
      if (!counts.has(row.id)) await supabase.from('tracks').update({ play_count_7d: 0 }).eq('id', row.id);
    }
  } catch (err) {
    console.error('[charts] recompute failed:', err);
  }
}
// Every 10 minutes is frequent enough that Trending feels responsive
// without turning this into a per-request cost on every Charts page load.
setInterval(recomputeWeeklyPlayCounts, 10 * 60 * 1000);
recomputeWeeklyPlayCounts(); // run once at boot so play_count_7d isn't empty until the first interval fires

// ─── Discovery ───────────────────────────────────────────────────────────────
// Every existing playlist/profile query in this file is scoped to a single
// owner or username (dbGetUserPlaylists(owner), dbGetProfile(username),
// etc) — there has never been a "browse everything public" query, because
// nothing before Discovery needed one. These two helpers are the first
// cross-user reads in the app and lean on the partial indexes added
// alongside this feature (idx_playlists_v2_public_likes,
// idx_playlists_v2_public_recent, idx_profiles_public_followers).

async function dbDiscoverPlaylists({ sort = 'likes', limit = 30 } = {}) {
  let q = supabase.from('playlists_v2').select('*').eq('is_public', true);
  q = sort === 'recent'
    ? q.order('updated_at', { ascending: false })
    : q.order('like_count', { ascending: false }).order('updated_at', { ascending: false });
  const { data, error } = await q.limit(limit);
  if (error) { console.error('[db] discoverPlaylists:', error.message); return []; }
  return data || [];
}

// Public profiles ranked by follower_count, as a simple "who's around"
// surface. Excludes the requester's own profile (seeing yourself on a
// "discover people" list is a known confusing pattern in other apps —
// nothing to discover about an account you already own) when a session is
// supplied; omitted entirely for anonymous requests.
async function dbDiscoverProfiles({ limit = 20, excludeUsername = null } = {}) {
  let q = supabase.from('profiles').select('*').eq('is_public', true)
    .order('follower_count', { ascending: false });
  if (excludeUsername) q = q.neq('username', excludeUsername);
  const { data, error } = await q.limit(limit);
  if (error) { console.error('[db] discoverProfiles:', error.message); return []; }
  return data || [];
}

// ─── Artist Discovery ───────────────────────────────────────────────────────
// Three modes, all reading the same `artists` + `artist_stats` join (a left
// join via the FK, so a brand-new artist with no artist_stats row yet still
// comes back — stats fields just arrive null, handled at the mapping layer
// in the route, not here):
//
//   trending — ranked by chart_rank (set by recomputeArtistStats off
//              total_plays_7d), nulls last. This is "what's hot right now",
//              and an artist with zero plays in the last 7 days has no
//              chart_rank at all (see that function's comment), so they
//              correctly never appear here — that's what "trending" means.
//
//   new      — created within NEW_ARTIST_WINDOW_DAYS, ordered newest-first,
//              zero dependency on plays/followers/chart_rank. This is the
//              guaranteed-visibility path: every artist passes through this
//              list for a fixed window right after creation, independent of
//              whether anyone's listened yet.
//
//   search   — name ILIKE match, ranked by follower_count as a reasonable
//              relevance proxy among matches (no trigram/full-text index on
//              artists.name yet — exact-substring ILIKE is the right cost
//              for what's realistically a small table).
const NEW_ARTIST_WINDOW_DAYS = 30;

async function dbDiscoverArtists({ mode = 'trending', limit = 20, query = null } = {}) {
  let q = supabase.from('artists').select('*, artist_stats(*)');

  if (mode === 'search' && query) {
    q = q.ilike('name', `%${query}%`).order('follower_count', { ascending: false }).limit(limit);
  } else if (mode === 'new') {
    const cutoff = new Date(Date.now() - NEW_ARTIST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    q = q.gte('created_at', cutoff).order('created_at', { ascending: false }).limit(limit);
  } else {
    // trending — chart_rank lives on artist_stats, a related table, so it
    // can't be ordered via the embedded-select query builder directly;
    // pull a generous candidate set ordered by created_at (cheap, indexed)
    // and rank client-side instead. Candidate set is capped well above any
    // realistic `limit` so this stays correct without scaling badly.
    const { data, error } = await q.limit(500);
    if (error) { console.error('[db] discoverArtists (trending):', error.message); return []; }
    const ranked = (data || [])
      .filter(a => a.artist_stats?.chart_rank != null)
      .sort((a, b) => a.artist_stats.chart_rank - b.artist_stats.chart_rank)
      .slice(0, limit);
    return ranked;
  }

  const { data, error } = await q;
  if (error) { console.error('[db] discoverArtists:', mode, error.message); return []; }
  return data || [];
}

// ─── Collaboration helpers ─────────────────────────────────────────────────
// Role check: returns 'owner' | 'editor' | 'viewer' | null (no access)
async function dbGetCollabRole(playlistId, username) {
  const pl = await dbGetPlaylist(playlistId);
  if (!pl) return null;
  if (pl.owner === username) return 'owner';
  const { data, error } = await supabase
    .from('playlist_collaborators')
    .select('role')
    .eq('playlist_id', playlistId)
    .eq('username', username)
    .maybeSingle();
  if (error || !data) return null;
  return data.role; // 'editor' | 'viewer'
}

// Create an invite (pending). Idempotent — upserts on the (playlist, invitee) unique key.
async function dbInviteCollaborator(playlistId, invitedBy, invitee, role) {
  // Prevent inviting the owner
  const pl = await dbGetPlaylist(playlistId);
  if (!pl) throw new Error('Playlist not found.');
  if (pl.owner === invitee) throw new Error('Cannot invite the playlist owner as a collaborator.');
  // Upsert: if there's already a pending invite, update the role.
  const { data, error } = await supabase
    .from('playlist_invites')
    .upsert({ playlist_id: playlistId, invited_by: invitedBy, invitee, role },
             { onConflict: 'playlist_id,invitee' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Accept an invite: writes collaborator row, deletes invite row.
async function dbAcceptInvite(inviteId, invitee) {
  const { data: inv, error: invErr } = await supabase
    .from('playlist_invites')
    .select('*')
    .eq('id', inviteId)
    .eq('invitee', invitee)
    .maybeSingle();
  if (invErr || !inv) throw new Error('Invite not found or not yours.');
  // Upsert collaborator (handles re-accept of same playlist if somehow re-invited)
  const { error: collabErr } = await supabase
    .from('playlist_collaborators')
    .upsert({ playlist_id: inv.playlist_id, username: inv.invitee, role: inv.role },
             { onConflict: 'playlist_id,username' });
  if (collabErr) throw new Error(collabErr.message);
  await supabase.from('playlist_invites').delete().eq('id', inviteId);
  return { playlistId: inv.playlist_id, role: inv.role };
}

// Reject or cancel invite
async function dbDeclineInvite(inviteId, username) {
  // Allow both invitee (reject) and invited_by/owner (cancel)
  const { data: inv } = await supabase
    .from('playlist_invites')
    .select('*')
    .eq('id', inviteId)
    .maybeSingle();
  if (!inv) throw new Error('Invite not found.');
  if (inv.invitee !== username && inv.invited_by !== username) {
    throw new Error('Not authorised to cancel this invite.');
  }
  await supabase.from('playlist_invites').delete().eq('id', inviteId);
}

async function dbRemoveCollaborator(playlistId, owner, username) {
  const pl = await dbGetPlaylist(playlistId);
  if (!pl || pl.owner !== owner) throw new Error('Not the playlist owner.');
  await supabase.from('playlist_collaborators')
    .delete().eq('playlist_id', playlistId).eq('username', username);
}

async function dbUpdateCollaboratorRole(playlistId, owner, username, role) {
  const pl = await dbGetPlaylist(playlistId);
  if (!pl || pl.owner !== owner) throw new Error('Not the playlist owner.');
  const { error } = await supabase.from('playlist_collaborators')
    .update({ role })
    .eq('playlist_id', playlistId)
    .eq('username', username);
  if (error) throw new Error(error.message);
}

async function dbGetCollaborators(playlistId) {
  const { data, error } = await supabase
    .from('playlist_collaborators')
    .select('username, role')
    .eq('playlist_id', playlistId)
    .order('username', { ascending: true });
  if (error) { console.error('[db] getCollaborators:', error.message); return []; }
  return data || [];
}

async function dbGetPendingInvites(playlistId) {
  const { data, error } = await supabase
    .from('playlist_invites')
    .select('id, invitee, role, created_at')
    .eq('playlist_id', playlistId)
    .order('created_at', { ascending: true });
  if (error) { console.error('[db] getPendingInvites:', error.message); return []; }
  return data || [];
}

// Invites waiting for `username` to accept/reject — shown in their notification inbox.
async function dbGetMyPendingInvites(username) {
  const { data, error } = await supabase
    .from('playlist_invites')
    .select('id, playlist_id, invited_by, role, created_at, playlists_v2(name)')
    .eq('invitee', username)
    .order('created_at', { ascending: false });
  if (error) { console.error('[db] getMyPendingInvites:', error.message); return []; }
  return (data || []).map(r => ({
    id: r.id, playlistId: r.playlist_id,
    playlistName: r.playlists_v2?.name || '(deleted)',
    invitedBy: r.invited_by, role: r.role, createdAt: r.created_at,
  }));
}

// Playlists the user is a collaborator on (not owner — that's /mine)
async function dbGetSharedWithMe(username) {
  const { data, error } = await supabase
    .from('playlist_collaborators')
    .select('role, playlists_v2(id, name, description, is_public, track_count, owner, updated_at)')
    .eq('username', username);
  if (error) { console.error('[db] getSharedWithMe:', error.message); return []; }
  return (data || [])
    .filter(r => r.playlists_v2)
    .sort((a, b) => new Date(b.playlists_v2.updated_at || 0) - new Date(a.playlists_v2.updated_at || 0))
    .map(r => ({
      role: r.role,
      id: r.playlists_v2.id, name: r.playlists_v2.name,
      description: r.playlists_v2.description,
      isPublic: r.playlists_v2.is_public,
      trackCount: r.playlists_v2.track_count,
      owner: r.playlists_v2.owner,
      updatedAt: r.playlists_v2.updated_at,
    }));
}

// Unpaginated by design — account deletion needs every storage_path to clean
// up the bucket fully, not one page of dbGetCloudFiles' results. Selecting
// only storage_path (not '*') keeps this cheap even for large libraries.
async function dbGetAllCloudStoragePaths(username) {
  const { data, error } = await supabase
    .from('cloud_files')
    .select('storage_path')
    .eq('owner', username);
  if (error) { console.error('[db] getAllCloudStoragePaths:', error.message); return []; }
  return (data || []).map(r => r.storage_path).filter(Boolean);
}

async function dbDeleteAccount(username) {
  // Clean up Storage objects first — deleting the metadata rows without
  // this would orphan the actual audio files in the bucket forever.
  const paths = await dbGetAllCloudStoragePaths(username);
  if (paths.length) {
    const { error } = await supabase.storage.from(CLOUD_BUCKET).remove(paths);
    if (error) console.error('[db] deleteAccount storage cleanup:', error.message);
  }
  await supabase.from('cloud_files').delete().eq('owner', username);
  await supabase.from('sessions').delete().eq('username', username);
  await supabase.from('playlists').delete().eq('username', username);
  await supabase.from('accounts').delete().eq('username', username);
}

async function dbCreateSession(token, username, expiresAt) {
  const { error } = await supabase.from('sessions').insert({
    token, username, expires_at: new Date(expiresAt).toISOString()
  });
  if (error) throw new Error(error.message);
}

async function dbGetSession(token) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('token', token)
    .single();
  if (error && error.code !== 'PGRST116') console.error('[db] getSession:', error.message);
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) {
    await supabase.from('sessions').delete().eq('token', token);
    return null;
  }
  // Fetch is_admin from accounts (cheap read, cached by Postgres for repeated calls)
  const { data: acct } = await supabase.from('accounts').select('is_admin').eq('username', data.username).maybeSingle();
  return { username: data.username, expiresAt: new Date(data.expires_at).getTime(), isAdmin: !!(acct?.is_admin) };
}

// Middleware: require an authenticated admin session
async function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.body?.token || req.query.token;
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Authentication required.' });
  if (!sess.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  req._adminSession = sess;
  next();
}

async function dbRefreshSession(token, expiresAt) {
  await supabase.from('sessions')
    .update({ expires_at: new Date(expiresAt).toISOString() })
    .eq('token', token);
}

async function dbDeleteSession(token) {
  await supabase.from('sessions').delete().eq('token', token);
}

async function dbGetPlaylists(username) {
  const { data, error } = await supabase
    .from('playlists')
    .select('data')
    .eq('username', username)
    .single();
  if (error && error.code !== 'PGRST116') console.error('[db] getPlaylists:', error.message);
  return data?.data || [];
}

async function dbSetPlaylists(username, playlists) {
  const { error } = await supabase.from('playlists').upsert(
    { username, data: playlists, updated_at: new Date().toISOString() },
    { onConflict: 'username' }
  );
  if (error) throw new Error(error.message);
}

// ─── Cloud Files (Supabase Storage + Postgres metadata) ───────────────────────
const CLOUD_BUCKET = 'cloud-audio';

// Columns the client is allowed to sort by, mapped to the actual DB column.
// 'name' sorts by filename since that's always populated; title is used as
// a secondary tiebreaker when present so ID3-tagged files still feel sorted
// by their real title where available.
const CLOUD_SORT_COLUMNS = {
  name:     'filename',
  artist:   'artist',
  date:     'uploaded_at',
  duration: 'duration',
};

// Cursor shape for keyset-capable columns: { v: <sort col value of last row
// of previous page>, id: <id of that row> }. id is always the tiebreaker so
// rows sharing an identical uploaded_at (batch uploads) or filename never
// get skipped or duplicated across page boundaries.
//
// Cursor shape for offset-fallback columns: { o: <row offset> }.
//
// Only 'date' and 'name' are keyset-paginated — backed by the two composite
// indexes added in migration_scale.sql (idx_cloud_files_owner_uploaded,
// idx_cloud_files_owner_filename). 'artist' and 'duration' have no dedicated
// composite index yet, so they fall back to offset pagination — slower at
// very large counts but still correct and unbounded, unlike capping at one
// page. Revisit with a real composite index if either becomes a hot sort.
function encodeCursor(row, col, keysetCapable) {
  return keysetCapable
    ? Buffer.from(JSON.stringify({ v: row[col], id: row.id })).toString('base64url')
    : null;
}
function encodeOffsetCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}
function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && (parsed.id != null || parsed.o != null)) return parsed;
  } catch (_) { /* malformed cursor — treat as no cursor, start from page 1 */ }
  return null;
}

const KEYSET_SORT_COLUMNS = new Set(['uploaded_at', 'filename']); // backed by composite indexes

async function dbGetCloudFiles(username, opts = {}) {
  const { folder, search, sort, dir, cursor, limit } = opts;

  function applyFolder(q) {
    // folder === undefined  → no filter (all files, any folder)
    // folder === ''  or '__unfiled__' → only files with no folder
    // folder === '<name>'   → only that folder
    if (folder === '__unfiled__' || folder === '') return q.is('folder', null);
    if (folder) return q.eq('folder', folder);
    return q;
  }

  const col = CLOUD_SORT_COLUMNS[sort] || 'uploaded_at';
  const ascending = dir === 'asc';
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const decodedCursor = decodeCursor(cursor);
  const keysetCapable = KEYSET_SORT_COLUMNS.has(col);

  let q = supabase.from('cloud_files').select('*').eq('owner', username);
  q = applyFolder(q);

  if (search) {
    // Single full-text query against the generated tsvector column —
    // replaces the old 3x .ilike() merge-and-sort-in-JS approach. 'websearch'
    // mode gives free quoted-phrase and -exclude support with no extra
    // parsing on our end.
    q = q.textSearch('search_vector', search, { type: 'websearch' })
         .order('uploaded_at', { ascending: false })
         .limit(pageSize);
    const { data, error } = await q;
    if (error) { console.error('[db] getCloudFiles search:', error.message); return { rows: [], nextCursor: null }; }
    // Search result sets aren't paginated (ranked by FTS match, not a stable
    // sort column) — capped at one page, the right tradeoff since search
    // result sets are naturally small.
    return { rows: data || [], nextCursor: null };
  }

  q = q.order(col, { ascending }).order('id', { ascending });

  if (keysetCapable && decodedCursor?.id != null) {
    // Keyset predicate: (col, id) strictly past the cursor row, respecting
    // sort direction. Matches the composite index column order exactly.
    const op = ascending ? 'gt' : 'lt';
    const valLiteral = `"${String(decodedCursor.v).replace(/"/g, '\\"')}"`;
    q = q.or(
      `${col}.${op}.${valLiteral},and(${col}.eq.${valLiteral},id.${op}.${decodedCursor.id})`
    );
  }

  const offset = (!keysetCapable && decodedCursor?.o) ? decodedCursor.o : 0;
  if (!keysetCapable) {
    // No composite index for artist/duration — fall back to range() offset
    // paging. Unbounded and correct, just O(offset) scan cost server-side;
    // acceptable until one of these becomes a frequently-used sort.
    q = q.range(offset, offset + pageSize - 1);
  } else {
    q = q.limit(pageSize);
  }

  const { data, error } = await q;
  if (error) { console.error('[db] getCloudFiles:', error.message); return { rows: [], nextCursor: null }; }
  const rows = data || [];
  let nextCursor = null;
  if (rows.length === pageSize) {
    nextCursor = keysetCapable
      ? encodeCursor(rows[rows.length - 1], col, true)
      : encodeOffsetCursor(offset + pageSize);
  }
  return { rows, nextCursor };
}

async function dbGetCloudFolders(username) {
  const { data, error } = await supabase
    .from('cloud_files')
    .select('folder')
    .eq('owner', username)
    .not('folder', 'is', null);
  if (error) { console.error('[db] getCloudFolders:', error.message); return []; }
  const set = new Set(data.map(r => r.folder).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function dbGetCloudFile(id, username) {
  const { data, error } = await supabase
    .from('cloud_files')
    .select('*')
    .eq('id', id)
    .eq('owner', username)   // ownership enforced in the query itself, not just checked after
    .single();
  if (error && error.code !== 'PGRST116') console.error('[db] getCloudFile:', error.message);
  return data || null;
}

// Fetches multiple files by id, scoped to owner. Used by bulk delete so we
// can resolve storage_paths for files that actually belong to the caller —
// any ids in the request that aren't theirs are silently dropped, not erred.
async function dbGetCloudFilesByIds(ids, username) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('cloud_files')
    .select('*')
    .in('id', ids)
    .eq('owner', username);
  if (error) { console.error('[db] getCloudFilesByIds:', error.message); return []; }
  return data || [];
}

async function dbInsertCloudFile(row) {
  const { data, error } = await supabase
    .from('cloud_files')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function dbDeleteCloudFile(id, username) {
  const { error } = await supabase
    .from('cloud_files')
    .delete()
    .eq('id', id)
    .eq('owner', username);  // same belt-and-suspenders ownership scoping
  if (error) throw new Error(error.message);
}

// Bulk delete by id, scoped to owner — same ownership guarantee as the
// single-file path, just expressed with .in() instead of .eq().
async function dbDeleteCloudFiles(ids, username) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('cloud_files')
    .delete()
    .in('id', ids)
    .eq('owner', username);
  if (error) throw new Error(error.message);
}

// Partial update for rename / move-to-folder. Only the fields present in
// `patch` are touched. Returns the updated row.
async function dbUpdateCloudFile(id, username, patch) {
  const { data, error } = await supabase
    .from('cloud_files')
    .update(patch)
    .eq('id', id)
    .eq('owner', username)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// schedulePersist is a no-op now — kept so no call sites break
function schedulePersist() {}

// ─── Crypto helpers ───────────────────────────────────────────────────────────
const PBKDF2_ITERS  = 100_000;
const PBKDF2_KEYLEN = 64;

async function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, 'sha256', (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}

function generateSalt()  { return crypto.randomBytes(16).toString('hex'); }
function generateToken() { return crypto.randomBytes(16).toString('hex'); }

const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;

// resolveToken is now a thin alias for dbGetSession — kept for any call sites
// that were not auth routes (there are none, but just in case)
async function resolveToken(token) {
  if (!token) return null;
  return dbGetSession(token);
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip     = req.ip || req.connection.remoteAddress || 'unknown';
  const now    = Date.now();
  const window = 60_000;
  const max    = 120;
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const hits = rateLimitMap.get(ip).filter(t => now - t < window);
  hits.push(now);
  rateLimitMap.set(ip, hits);
  if (hits.length > max) return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateLimitMap) {
    const fresh = hits.filter(t => now - t < 60_000);
    if (!fresh.length) rateLimitMap.delete(ip); else rateLimitMap.set(ip, fresh);
  }
}, 300_000);

// Generic factory for tighter, per-action limiters distinct from the global
// per-IP backstop above. Keyed by whatever `keyFn` returns for the request —
// for follow/unfollow that's the caller's username (set after dbGetSession
// resolves), not their IP, since a logged-in abuser can rotate IPs far more
// easily than usernames. Reusable for future per-action limits (likes,
// comments, chat) without duplicating the sliding-window logic each time.
function makeActionRateLimit({ windowMs, max, keyFn, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      const fresh = times.filter(t => now - t < windowMs);
      if (!fresh.length) hits.delete(key); else hits.set(key, fresh);
    }
  }, Math.max(windowMs, 60_000));
  return function actionRateLimit(req, res, next) {
    const key = keyFn(req);
    if (!key) return next(); // no key yet (e.g. unauthenticated) — let the route's own auth check reject it
    const now = Date.now();
    const times = (hits.get(key) || []).filter(t => now - t < windowMs);
    times.push(now);
    hits.set(key, times);
    if (times.length > max) return res.status(429).json({ error: message || 'Rate limit exceeded. Please slow down.' });
    next();
  };
}

// Likes: same session-resolving, username-keyed pattern as followRateLimit
// and playlistRateLimit. 60/min is generous — a like is a single tap, and
// someone briskly liking through a profile's playlists shouldn't hit this,
// but a script hammering the endpoint should.
async function likeRateLimit(req, res, next) {
  const token = req.body?.token || req.query?.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  req._session = sess; // route handler reuses this instead of resolving again
  if (!sess) return next(); // unauthenticated — the route's own 401 check handles this
  const key = sess.username;
  const now = Date.now();
  const times = (likeRateLimitHits.get(key) || []).filter(t => now - t < 60_000);
  times.push(now);
  likeRateLimitHits.set(key, times);
  if (times.length > 60) {
    return res.status(429).json({ error: 'Too many likes. Please slow down.' });
  }
  next();
}
const likeRateLimitHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of likeRateLimitHits) {
    const fresh = times.filter(t => now - t < 60_000);
    if (!fresh.length) likeRateLimitHits.delete(key); else likeRateLimitHits.set(key, fresh);
  }
}, 60_000);

// Follow/unfollow specifically: tighter than the global 120/min-per-IP
// backstop. Keyed by the *caller's resolved username*, not their raw token —
// keying on the token would give a user with two active sessions (two
// devices, or a deliberately-opened second session) two independent 30/min
// buckets, which defeats the per-account intent. Resolving the session here
// means this middleware is async (dbGetSession hits the DB), and the route
// handler reuses req._followSession instead of resolving it a second time.
async function followRateLimit(req, res, next) {
  const token = req.body?.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  req._followSession = sess; // let the route handler skip a redundant dbGetSession call
  if (!sess) return next(); // unauthenticated — the route's own 401 check handles this
  const key = sess.username;
  const now = Date.now();
  const times = (followRateLimitHits.get(key) || []).filter(t => now - t < 60_000);
  times.push(now);
  followRateLimitHits.set(key, times);
  if (times.length > 30) {
    return res.status(429).json({ error: 'Too many follow/unfollow actions. Please slow down.' });
  }
  next();
}
const followRateLimitHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of followRateLimitHits) {
    const fresh = times.filter(t => now - t < 60_000);
    if (!fresh.length) followRateLimitHits.delete(key); else followRateLimitHits.set(key, fresh);
  }
}, 60_000);

// Playlist writes (create/update/delete/add-track/remove-track): same
// session-resolving, username-keyed pattern as followRateLimit, for the
// same reason — keying on the raw token would let a multi-session user
// dodge the limit. Looser than follow (60/min vs 30/min) since legitimate
// use (building a 50-track playlist in one sitting) involves many more
// individual write calls than legitimate follow activity ever would.
async function playlistRateLimit(req, res, next) {
  const token = req.body?.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  req._session = sess; // route handler reuses this instead of resolving again
  if (!sess) return next(); // unauthenticated — the route's own 401 check handles this
  const key = sess.username;
  const now = Date.now();
  const times = (playlistRateLimitHits.get(key) || []).filter(t => now - t < 60_000);
  times.push(now);
  playlistRateLimitHits.set(key, times);
  if (times.length > 60) {
    return res.status(429).json({ error: 'Too many playlist changes. Please slow down.' });
  }
  next();
}
const playlistRateLimitHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of playlistRateLimitHits) {
    const fresh = times.filter(t => now - t < 60_000);
    if (!fresh.length) playlistRateLimitHits.delete(key); else playlistRateLimitHits.set(key, fresh);
  }
}, 60_000);

// ─── HTTP fetch helper (spoofs browser UA so YT doesn't block) ────────────────
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchHTML(url, timeoutMs = 8000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': YT_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        // Bypass GDPR/cookie consent gate that returns empty ytInitialData
        'Cookie': 'CONSENT=YES+; SOCS=CAESEwgDEgk0OTA3NzkzMjQaAmVuIAEaBgiAo_CmBg==',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── YouTube page scraper — extracts ytInitialData ────────────────────────────
/**
 * Parses YouTube's ytInitialData JSON embedded in the page source.
 * Returns parsed object or null.
 */
function extractYtInitialData(html) {
  // Strategy 1: find the var / window assignment, then balance braces to capture full JSON
  const starts = [
    /var ytInitialData\s*=\s*\{/,
    /window\["ytInitialData"\]\s*=\s*\{/,
    /ytInitialData\s*=\s*\{/,
  ];
  for (const pat of starts) {
    const m = html.search(pat);
    if (m === -1) continue;
    const start = html.indexOf('{', m);
    if (start === -1) continue;
    let depth = 0, i = start, inStr = false, escape = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (escape) { escape = false; continue; }
      if (c === '\\' && inStr) { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    try { return JSON.parse(html.slice(start, i + 1)); } catch { continue; }
  }
  return null;
}

/**
 * Walks ytInitialData to find all videoRenderer / playlistVideoRenderer objects.
 * Returns array of { id, title, duration, thumb }.
 */
function extractTracksFromYtData(data) {
  const tracks = [];
  const seen   = new Set();

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    // playlistVideoRenderer (playlist page)
    if (obj.playlistVideoRenderer) {
      const r  = obj.playlistVideoRenderer;
      const id = r.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title    = r.title?.runs?.[0]?.text || r.title?.simpleText || 'Unknown';
        const durText  = r.lengthText?.simpleText || r.lengthText?.runs?.[0]?.text || null;
        const thumbs   = r.thumbnail?.thumbnails || [];
        const thumb    = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        tracks.push({ id, title, duration: durText, thumb });
      }
    }
    // videoRenderer (search results / channel page)
    if (obj.videoRenderer) {
      const r  = obj.videoRenderer;
      const id = r.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title   = r.title?.runs?.[0]?.text || r.title?.simpleText || 'Unknown';
        const durText = r.lengthText?.simpleText || null;
        const thumbs  = r.thumbnail?.thumbnails || [];
        const thumb   = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        tracks.push({ id, title, duration: durText, thumb });
      }
    }
    // gridVideoRenderer (channel videos tab)
    if (obj.gridVideoRenderer) {
      const r  = obj.gridVideoRenderer;
      const id = r.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title   = r.title?.runs?.[0]?.text || r.title?.simpleText || 'Unknown';
        const durText = r.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || null;
        const thumbs  = r.thumbnail?.thumbnails || [];
        const thumb   = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        tracks.push({ id, title, duration: durText, thumb });
      }
    }
    // reelsItemRenderer (Shorts)
    if (obj.reelsItemRenderer) {
      const r  = obj.reelsItemRenderer;
      const id = r.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title = r.headline?.simpleText || r.accessibility?.accessibilityData?.label || 'Short';
        const thumbs = r.thumbnail?.thumbnails || [];
        const thumb  = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        tracks.push({ id, title, duration: null, thumb });
      }
    }
    // richItemRenderer (home feed / shorts shelf)
    if (obj.richItemRenderer) walk(obj.richItemRenderer.content);

    // ── YouTube Music renderers ──────────────────────────────────────────────
    // musicVideoRenderer (YT Music search results / album tracks)
    if (obj.musicVideoRenderer) {
      const r  = obj.musicVideoRenderer;
      const id = r.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title   = r.title?.runs?.[0]?.text || r.title?.simpleText || 'Unknown';
        const durText = r.lengthText?.runs?.[0]?.text || r.lengthText?.simpleText || null;
        const thumbs  = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
          || r.thumbnail?.thumbnails || [];
        const thumb   = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        tracks.push({ id, title, duration: durText, thumb });
      }
    }
    // musicTwoRowItemRenderer (YT Music playlists / album grid)
    if (obj.musicTwoRowItemRenderer) {
      const r         = obj.musicTwoRowItemRenderer;
      const navEp     = r.navigationEndpoint?.watchEndpoint
        || r.navigationEndpoint?.watchPlaylistEndpoint;
      const id        = navEp?.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title   = r.title?.runs?.[0]?.text || r.title?.simpleText || 'Unknown';
        const thumbs  = r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails
          || r.thumbnail?.thumbnails || [];
        const thumb   = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        tracks.push({ id, title, duration: null, thumb });
      }
    }
    // musicResponsiveListItemRenderer (YT Music queue / playlist page rows)
    if (obj.musicResponsiveListItemRenderer) {
      const r      = obj.musicResponsiveListItemRenderer;
      const ovEp   = r.overlay?.musicItemThumbnailOverlayRenderer
        ?.startMusicPlayCommand?.watchEndpoint;
      const flexEp = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
        ?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint;
      const id     = ovEp?.videoId || flexEp?.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const titleRun = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
          ?.text?.runs?.[0];
        const title    = titleRun?.text || 'Unknown';
        // Duration is usually in flexColumns[1] or fixedColumns[0]
        const durRun   = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer
          ?.text?.runs?.[0]
          || r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer
          ?.text?.runs?.[0];
        const durText  = durRun?.text || null;
        const thumbs   = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
          || r.thumbnail?.thumbnails || [];
        const thumb    = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        tracks.push({ id, title, duration: durText, thumb });
      }
    }

    // Recurse into arrays and objects
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v && typeof v === 'object') walk(v);
    }
  }

  walk(data);
  return tracks;
}

/**
 * Extract playlist title from ytInitialData.
 */
function extractPlaylistTitle(data) {
  try {
    // playlist page: sidebar has metadata
    const header = data?.header?.playlistHeaderRenderer
      || data?.sidebar?.playlistSidebarRenderer?.items?.[0]?.playlistSidebarPrimaryInfoRenderer;
    if (header?.title?.runs?.[0]?.text) return header.title.runs[0].text;
    if (header?.title?.simpleText)      return header.title.simpleText;
    // microformat
    const mf = data?.microformat?.microformatDataRenderer;
    if (mf?.title) return mf.title;
  } catch {}
  return null;
}

// ─── YouTube oEmbed embed-check ───────────────────────────────────────────────
/**
 * Checks whether a YouTube video ID can be embedded.
 * Uses oEmbed endpoint — if it returns 401/403 or the response has
 * "Video not found" it means embedding is disabled.
 * Free, no API key.
 */
async function checkYtEmbeddable(videoId) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': YT_UA } });
    if (res.status === 401 || res.status === 403) return { embeddable: false };
    if (!res.ok) return { embeddable: false };
    const data = await res.json();
    // If the title is returned it's embeddable
    return { embeddable: true, title: data.title || null, thumb: data.thumbnail_url || null };
  } catch {
    return { embeddable: false };
  }
}

// ─── Platform Detection ───────────────────────────────────────────────────────
function detectPlatform(url) {
  try {
    const { hostname } = new URL(url);
    const h = hostname.replace(/^www\./, '');
    if (h === 'music.youtube.com')                          return 'ytmusic';
    if (h === 'youtube.com' || h === 'youtu.be')            return 'youtube';
    if (h === 'open.spotify.com')                           return 'spotify';
    if (h === 'tidal.com')                                  return 'tidal';
    if (h === 'soundcloud.com')                             return 'soundcloud';
    if (h === 'music.apple.com')                            return 'applemusic';
    if (h === 'music.amazon.com')                           return 'amazon';
    if (h === 'open.qobuz.com' || h === 'play.qobuz.com')  return 'qobuz';
    if (h === 'deezer.com' || h === 'www.deezer.com')       return 'deezer';
    if (h === 'last.fm' || h === 'www.last.fm')             return 'lastfm';
  } catch (_) {}
  return null;
}

// ─── Embed URL Builders ───────────────────────────────────────────────────────

/**
 * resolveYouTube — v4.1
 * - Returns both standard and nocookie embed URLs
 * - Detects playlist vs video
 * - Sets title from URL when possible
 */
function resolveYouTube(url) {
  const u = new URL(url);

  // YT Music browse paths  e.g. /browse/VLPL...
  const browsePath = u.pathname.match(/^\/browse\/(VL[A-Za-z0-9_-]+)/);
  if (browsePath) {
    const listId = browsePath[1].replace(/^VL/, '');
    return buildYtPlaylistResult(listId, url);
  }

  const listId  = u.searchParams.get('list');
  const videoId = u.searchParams.get('v')
    || (u.hostname === 'youtu.be' ? u.pathname.replace(/^\//, '').split('?')[0] : null);

  // Playlist (possibly with a starting video)
  if (listId && !videoId) return buildYtPlaylistResult(listId, url);

  // Video (possibly also in a playlist — treat as video)
  if (videoId && videoId.length >= 11) return buildYtVideoResult(videoId, listId, url);

  // Shorts /shorts/<id>
  const shortsMatch = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
  if (shortsMatch) return buildYtVideoResult(shortsMatch[1], null, url);

  // Channel / handle pages: not directly playable, return as link for track-fetch
  const channelMatch = u.pathname.match(/^\/@([^/]+)|^\/channel\/([A-Za-z0-9_-]+)/);
  if (channelMatch) {
    const handle = channelMatch[1] || channelMatch[2];
    return {
      type: 'channel',
      embedUrl: `/redirect?url=${encodeURIComponent(url)}&platform=youtube`,
      id: handle,
      title: `@${handle}`,
      canFetchTracks: true,
    };
  }

  return null;
}

function buildYtVideoResult(videoId, listId, originalUrl) {
  const params = new URLSearchParams({
    autoplay: '1', controls: '1', enablejsapi: '1', origin: 'https://freq.app',
    ...(listId ? { list: listId } : {}),
  });
  return {
    type:        'video',
    embedUrl:    `https://www.youtube.com/embed/${videoId}?${params}`,
    embedUrlNC:  `https://www.youtube-nocookie.com/embed/${videoId}?${params}`, // nocookie fallback
    id:          videoId,
    canFetchTracks: false,
  };
}

function buildYtPlaylistResult(listId, originalUrl) {
  const params = new URLSearchParams({ list: listId, autoplay: '1', controls: '1' });
  return {
    type:        'playlist',
    embedUrl:    `https://www.youtube.com/embed/videoseries?${params}`,
    embedUrlNC:  `https://www.youtube-nocookie.com/embed/videoseries?${params}`,
    id:          listId,
    canFetchTracks: true,
  };
}

function resolveSpotify(url) {
  const match = new URL(url).pathname.match(/^\/(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/);
  if (!match) return null;
  const [, type, id] = match;
  return { type, embedUrl:`https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0`, id };
}

function resolveTidal(url) {
  const match = new URL(url).pathname.match(/\/(playlist|album|track)\/([^/?]+)/);
  if (!match) return null;
  const [, type, id] = match;
  return { type, embedUrl:`https://embed.tidal.com/${type}s/${id}`, id };
}

function resolveSoundCloud(url) {
  const type = (url.includes('/sets/') || url.includes('/likes/')) ? 'playlist' : 'track';
  const params = new URLSearchParams({
    url, color:'%23ff5500', auto_play:'true', hide_related:'false',
    show_comments:'true', show_user:'true', show_reposts:'false', show_teaser:'true', visual:'true',
  });
  return { type, embedUrl:`https://w.soundcloud.com/player/?${params.toString()}`, id:url };
}

function resolveAppleMusic(url) {
  const u = new URL(url);
  // Strip locale path prefix if present (e.g. /us/album/...)
  // Normalise to global embed
  const playlistMatch = u.pathname.match(/^\/([a-z]{2})\/playlist\/(?:[^/]*\/)?(pl\.[A-Za-z0-9]+)/);
  if (playlistMatch) {
    const [, country, id] = playlistMatch;
    return { type:'playlist', embedUrl:`https://embed.music.apple.com/${country}/playlist/${id}`, id };
  }
  const albumMatch = u.pathname.match(/^\/([a-z]{2})\/(?:album|song)\/(?:[^/]*\/)?([\d]+)/);
  if (!albumMatch) {
    // try without locale
    const noLocale = u.pathname.match(/^\/((?:album|song|playlist)\/[^?]+)/);
    if (noLocale) return { type:'link', embedUrl:`https://embed.music.apple.com/${noLocale[1]}`, id:noLocale[1] };
    return null;
  }
  const [, country, id] = albumMatch;
  const trackId = u.searchParams.get('i');
  if (trackId) return { type:'track', embedUrl:`https://embed.music.apple.com/${country}/album/${id}?i=${trackId}`, id };
  return { type:'album', embedUrl:`https://embed.music.apple.com/${country}/album/${id}`, id };
}

function resolveAmazon(url) {
  const u = new URL(url);
  const match = u.pathname.match(/\/(playlists?|albums?|tracks?|artists?)\/([^/?]+)/i);
  let type = 'link', id = url;
  if (match) { type = match[1].replace(/s$/, '').toLowerCase(); id = match[2]; }
  return { type, embedUrl:`/redirect?url=${encodeURIComponent(url)}&platform=amazon`, id };
}

function resolveQobuz(url) {
  const match = new URL(url).pathname.match(/\/(album|playlist|track)\/([^/?]+)/);
  if (!match) return null;
  const [, type, id] = match;
  return { type, embedUrl:`/redirect?url=${encodeURIComponent(url)}&platform=qobuz`, id };
}

function resolveDeezer(url) {
  const u = new URL(url);
  const match = u.pathname.match(/(?:\/[a-z]{2})?\/?(track|playlist|album|artist|radio)\/([0-9]+)/i);
  if (!match) return null;
  const [, rawType, id] = match;
  const type = rawType.toLowerCase();
  return {
    type,
    embedUrl: `https://widget.deezer.com/widget/dark/${type}/${id}`,
    id,
  };
}

function resolveLastFm(url) {
  const u = new URL(url);
  const pathname = u.pathname;
  let type = 'link', id = url;

  const musicMatch = pathname.match(/^\/music\/([^/]+)(?:\/_\/([^/]+)|\/([^/]+))?/);
  const userMatch  = pathname.match(/^\/user\/([^/]+)/);
  const tagMatch   = pathname.match(/^\/tag\/([^/]+)/);

  if (musicMatch) {
    const [, artist, track, album] = musicMatch;
    if (track)      { type = 'track';  id = decodeURIComponent(artist) + ' — ' + decodeURIComponent(track); }
    else if (album) { type = 'album';  id = decodeURIComponent(artist) + ' · ' + decodeURIComponent(album); }
    else            { type = 'artist'; id = decodeURIComponent(artist); }
  } else if (userMatch) {
    type = 'profile'; id = decodeURIComponent(userMatch[1]);
  } else if (tagMatch) {
    type = 'tag'; id = decodeURIComponent(tagMatch[1]);
  }

  return {
    type,
    embedUrl: `/redirect?url=${encodeURIComponent(url)}&platform=lastfm`,
    id,
  };
}

// ─── Resolver Map ─────────────────────────────────────────────────────────────
const RESOLVERS = {
  youtube:    resolveYouTube,
  ytmusic:    resolveYouTube,
  spotify:    resolveSpotify,
  tidal:      resolveTidal,
  soundcloud: resolveSoundCloud,
  applemusic: resolveAppleMusic,
  amazon:     resolveAmazon,
  qobuz:      resolveQobuz,
  deezer:     resolveDeezer,
  lastfm:     resolveLastFm,
};

// ─── Redirect Brand Config ────────────────────────────────────────────────────
const REDIRECT_BRANDS = {
  amazon:  { name:'Amazon Music', color:'#00A8E1', bgColor:'#0f1923', emoji:'◈' },
  qobuz:   { name:'Qobuz',        color:'#05b8cc', bgColor:'#050f14', emoji:'◉' },
  lastfm:  { name:'Last.fm',      color:'#d51007', bgColor:'#0e0505', emoji:'⊕' },
  youtube: { name:'YouTube',      color:'#ff0000', bgColor:'#0a0000', emoji:'▶' },
};

app.get('/redirect', (req, res) => {
  const targetUrl = req.query.url    || '';
  const platform  = req.query.platform || 'amazon';
  const brand     = REDIRECT_BRANDS[platform] || REDIRECT_BRANDS.amazon;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="3;url=${encodeURI(decodeURIComponent(targetUrl))}">
  <title>${brand.name}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Unbounded:wght@700;900&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    body{background:${brand.bgColor};font-family:'Space Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:22px;color:#fff;padding:32px;}
    .icon{font-size:3rem;}
    .badge{background:${brand.color};color:#000;font-family:'Unbounded',sans-serif;font-weight:900;font-size:0.65rem;padding:5px 14px;border-radius:3px;letter-spacing:0.18em;text-transform:uppercase;}
    h2{font-family:'Unbounded',sans-serif;font-size:1.1rem;letter-spacing:-0.01em;text-align:center;}
    p{color:#778;font-size:0.75rem;text-align:center;line-height:1.8;}
    a{color:${brand.color};text-decoration:none;font-weight:700;}
    a:hover{text-decoration:underline;}
    .bar-wrap{width:220px;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;}
    .bar-fill{height:100%;background:${brand.color};border-radius:2px;animation:fill 3s linear forwards;}
    @keyframes fill{from{width:0%;}to{width:100%;}}
    .note{font-size:0.62rem;color:#444;margin-top:8px;text-align:center;line-height:1.9;}
  </style>
</head>
<body>
  <div class="icon">${brand.emoji}</div>
  <div class="badge">${brand.name}</div>
  <h2>Opening in ${brand.name}…</h2>
  <div class="bar-wrap"><div class="bar-fill"></div></div>
  <p>Redirecting automatically.<br><a href="${decodeURIComponent(targetUrl)}" target="_blank">Click here</a> if it doesn't open.</p>
  <p class="note">${brand.name} doesn't support embedded playback in third-party apps.<br>Your link will open in a new tab.</p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  // Live account count from Supabase (best-effort — don't fail the health check)
  let accounts = 0;
  try {
    const { count } = await supabase.from('accounts').select('*', { count: 'exact', head: true });
    accounts = count || 0;
  } catch (_) {}
  res.json({
    status:   'ok',
    version:  '4.5',
    uptime:   Math.floor(process.uptime()),
    platform: process.platform,
    accounts,
  });
});

// ─── POST /api/resolve ────────────────────────────────────────────────────────
app.post('/api/resolve', rateLimit, (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string')
    return res.status(400).json({ error: 'Request body must include a "url" string.' });

  const trimmed  = url.trim();
  const platform = detectPlatform(trimmed);
  if (!platform)
    return res.status(400).json({
      error: 'Unsupported platform. Paste a URL from YouTube, YT Music, Spotify, Tidal, SoundCloud, Apple Music, Amazon Music, Qobuz, Deezer, or Last.fm.',
    });

  try {
    const info = RESOLVERS[platform](trimmed);
    if (!info) return res.status(400).json({ error: `Could not extract a playable ID from this ${platform} URL. Check that the link is public and not a redirect.` });
    return res.json({ platform, originalUrl: trimmed, ...info });
  } catch (err) {
    console.error(`[resolve] ${platform}:`, err.message);
    return res.status(400).json({ error: `Could not parse this URL: ${err.message}` });
  }
});

// ─── POST /api/import (batch) ─────────────────────────────────────────────────
app.post('/api/import', rateLimit, (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || !urls.length)
    return res.status(400).json({ error: 'Request body must include a "urls" array.' });
  if (urls.length > 200)
    return res.status(400).json({ error: 'Maximum 200 URLs per import.' });

  const results = urls.map(rawUrl => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { error:'Invalid URL', url:rawUrl };
    const trimmed  = rawUrl.trim();
    const platform = detectPlatform(trimmed);
    if (!platform) return { error:'Unsupported platform', url:trimmed };
    try {
      const info = RESOLVERS[platform](trimmed);
      if (!info) return { error:'Could not parse URL', url:trimmed };
      return { platform, originalUrl:trimmed, ...info };
    } catch (err) {
      return { error:err.message, url:trimmed };
    }
  });

  return res.json({
    succeeded: results.filter(r => !r.error),
    failed:    results.filter(r =>  r.error),
    total:     results.length,
  });
});

// ─── POST /api/yt/tracks  (NEW v4.1) ─────────────────────────────────────────
/**
 * Body: { url: string }
 * Returns: { type, title, tracks: [{ id, title, duration, thumb, embedUrl }] }
 *
 * Strategy:
 *   1. Fetch the YouTube page HTML with a browser UA
 *   2. Extract ytInitialData JSON
 *   3. Walk it to collect all video renderers
 *   4. Return track list — client decides which to queue
 *
 * Supports: watch?v=, playlist?list=, /shorts/, /@handle, /channel/
 */
app.post('/api/yt/tracks', rateLimit, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string')
    return res.status(400).json({ error: '"url" required.' });

  const trimmed = url.trim();
  // Only allow YouTube URLs
  const platform = detectPlatform(trimmed);
  if (platform !== 'youtube' && platform !== 'ytmusic')
    return res.status(400).json({ error: 'Only YouTube / YT Music URLs are supported for track listing.' });

  // Normalise: ensure we're fetching the right page
  let fetchUrl = trimmed;
  try {
    const u = new URL(trimmed);
    // For a single video, fetch the video page — it shows related/playlist tracks
    // For a playlist, fetch playlist?list=...
    if (!u.searchParams.get('list') && !u.pathname.startsWith('/playlist')) {
      // Single video page — we'll get the "Up next" / playlist continuation
      // Just use the URL as-is
    }
    // YT Music → convert to regular youtube.com for scraping
    if (u.hostname === 'music.youtube.com') {
      u.hostname = 'www.youtube.com';
      fetchUrl = u.toString();
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  console.log(`[yt/tracks] Fetching: ${fetchUrl}`);

  try {
    const html = await fetchHTML(fetchUrl, 10000);

    if (!html || html.length < 1000) {
      return res.status(502).json({ error: 'YouTube returned an empty response. Try again.' });
    }

    if (html.includes('Sorry, something went wrong') || html.includes('Our systems have detected unusual traffic')) {
      return res.status(429).json({ error: 'YouTube rate limited. Please wait a moment and try again.' });
    }

    const ytData = extractYtInitialData(html);
    if (!ytData) {
      return res.status(502).json({ error: 'Could not parse YouTube page data. The page structure may have changed.' });
    }

    const tracks = extractTracksFromYtData(ytData);
    const title  = extractPlaylistTitle(ytData) || null;

    if (!tracks.length) {
      return res.status(404).json({ error: 'No tracks found on this page. The playlist may be private or empty.' });
    }

    // Build embedUrl for each track
    const tracksWithEmbed = tracks.map(t => ({
      ...t,
      embedBlocked: false,    // default; player updates via /api/yt/embed-check at playback time
      embedUrl:   `https://www.youtube.com/embed/${t.id}?autoplay=1&controls=1&enablejsapi=1`,
      embedUrlNC: `https://www.youtube-nocookie.com/embed/${t.id}?autoplay=1&controls=1&enablejsapi=1`,
      originalUrl: `https://www.youtube.com/watch?v=${t.id}`,
      platform:   'youtube',
      type:       'video',
    }));

    console.log(`[yt/tracks] Found ${tracksWithEmbed.length} tracks, title: "${title}"`);

    return res.json({
      type:   'playlist',
      title:  title || 'YouTube Playlist',
      tracks: tracksWithEmbed,
      total:  tracksWithEmbed.length,
      sourceUrl: trimmed,
    });

  } catch (err) {
    console.error('[yt/tracks] Error:', err.message);
    return res.status(502).json({ error: `Could not fetch YouTube page: ${err.message}` });
  }
});

// ─── GET /api/yt/embed-check  (NEW v4.1) ─────────────────────────────────────
/**
 * Query: ?id=<videoId>
 * Returns: { id, embeddable: bool, title?, thumb? }
 *
 * Uses YouTube's free oEmbed endpoint — no API key needed.
 * 401/403 = embedding disabled by uploader.
 */
app.get('/api/yt/embed-check', rateLimit, async (req, res) => {
  const { id } = req.query;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id))
    return res.status(400).json({ error: 'Valid YouTube video ID required.' });

  try {
    const result = await checkYtEmbeddable(id);
    return res.json({ id, ...result });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES  — Supabase-backed
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/signup', rateLimit, async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const key = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!key || key.length < 2)
    return res.status(400).json({ error: 'Username must be 2+ alphanumeric chars or underscores.' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });

  try {
    const existing = await dbGetAccount(key);
    if (existing) return res.status(409).json({ error: 'Username already taken.' });

    const salt        = generateSalt();
    const hash        = await hashPassword(password, salt);
    const dName       = (displayName || '').trim() || key;
    await dbCreateAccount(key, dName, salt, hash);
    try {
      await dbCreateProfile(key, dName);
    } catch (profileErr) {
      // dbCreateProfile now throws instead of silently logging (see the
      // comment above its definition) — this is exactly the failure mode
      // that previously left an account with no profile row, invisible to
      // Find a User/Discovery with no way for the user to tell why. Roll
      // the account back rather than leave that same half-created state:
      // accounts.username -> profiles.username is ON DELETE CASCADE, and
      // nothing else has been written yet (no session, no playlists row),
      // so this delete is a clean, complete undo of dbCreateAccount above.
      console.error('[signup] profile creation failed, rolling back account:', profileErr.message);
      await supabase.from('accounts').delete().eq('username', key);
      throw new Error('Could not finish creating your account. Please try again.');
    }
    await dbSetPlaylists(key, []);

    const token     = generateToken();
    const expiresAt = Date.now() + TOKEN_TTL;
    await dbCreateSession(token, key, expiresAt);

    return res.status(201).json({ token, username: key, displayName: dName });
  } catch (err) {
    console.error('[signup]', err);
    return res.status(500).json({ error: 'Server error during signup.' });
  }
});

app.post('/api/auth/signin', rateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const key  = username.trim().toLowerCase();
  try {
    const acct = await dbGetAccount(key);
    if (!acct) return res.status(401).json({ error: 'No account found with that username.' });
    if (acct.is_banned) return res.status(403).json({ error: 'This account has been suspended.' });

    const hash = await hashPassword(password, acct.salt);
    if (hash !== acct.hash) return res.status(401).json({ error: 'Incorrect password.' });

    const token     = generateToken();
    const expiresAt = Date.now() + TOKEN_TTL;
    await dbCreateSession(token, key, expiresAt);
    const playlists = await dbGetPlaylists(key);
    dbEnsureProfile(key, acct.display_name); // fire-and-forget self-heal — see dbEnsureProfile's comment

    return res.json({ token, username: key, displayName: acct.display_name, playlists });
  } catch (err) {
    console.error('[signin]', err);
    return res.status(500).json({ error: 'Server error during sign in.' });
  }
});

app.post('/api/auth/token-refresh', async (req, res) => {
  const { token } = req.body;
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token.' });
  const expiresAt = Date.now() + TOKEN_TTL;
  await dbRefreshSession(token, expiresAt);
  return res.json({ ok: true, expiresAt });
});

app.post('/api/auth/sync', async (req, res) => {
  const { token, playlists } = req.body;
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!Array.isArray(playlists)) return res.status(400).json({ error: '"playlists" must be an array.' });
  if (JSON.stringify(playlists).length > 2_000_000)
    return res.status(413).json({ error: 'Playlist data exceeds 2 MB limit.' });
  try {
    await dbSetPlaylists(sess.username, playlists);
    return res.json({ ok: true, synced: playlists.length, syncedAt: Date.now() });
  } catch (err) {
    console.error('[sync]', err);
    return res.status(500).json({ error: 'Sync failed.' });
  }
});

app.get('/api/auth/pull', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const acct      = await dbGetAccount(sess.username);
    const playlists = await dbGetPlaylists(sess.username);
    dbEnsureProfile(sess.username, acct?.display_name || sess.username); // fire-and-forget self-heal
    return res.json({
      username:    sess.username,
      displayName: acct?.display_name || sess.username,
      playlists,
      pulledAt:    Date.now(),
    });
  } catch (err) {
    console.error('[pull]', err);
    return res.status(500).json({ error: 'Pull failed.' });
  }
});

app.delete('/api/auth/account', async (req, res) => {
  const token = req.body.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token.' });
  try {
    await dbDeleteAccount(sess.username);
    return res.json({ ok: true, deleted: sess.username });
  } catch (err) {
    console.error('[delete-account]', err);
    return res.status(500).json({ error: 'Account deletion failed.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PROFILES — public-facing profile data, backed by the `profiles` table
//  (separate from `accounts`, see dbCreateProfile comment — credentials
//  never live anywhere a "get public profile" code path could reach them)
//
//  GET   /api/profiles/:username   → { username, displayName, bio, isPublic }
//                                     404 if no profile, or profile is private
//                                     and requester isn't its owner
//  PATCH /api/profiles/me          { token, bio?, displayName?, isPublic? }
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/profiles/:username', async (req, res) => {
  const key = (req.params.username || '').trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'Username required.' });
  try {
    const profile = await dbGetProfile(key);
    if (!profile) return res.status(404).json({ error: 'No profile found for that username.' });

    // Private profiles are only visible to their own owner — checked against
    // the requester's session, never against anything the client merely
    // claims. An expired/missing token on a private profile request is
    // treated the same as "not the owner": a 404, not a 401, so a private
    // profile's existence can't be probed by an unauthenticated request.
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    const sess  = await dbGetSession(token);
    if (!profile.is_public) {
      if (!sess || sess.username !== key) {
        return res.status(404).json({ error: 'No profile found for that username.' });
      }
    }

    // isFollowing is relative to whoever's asking — null (not false) for an
    // unauthenticated request, so the frontend can distinguish "you aren't
    // following them" from "we don't know, you're not signed in" and hide
    // the follow button rather than show it in a misleading state.
    const isFollowing = (sess && sess.username !== key) ? await dbIsFollowing(sess.username, key) : null;

    // isArtist/artistSlug drive the profile page's "Become an Artist" CTA
    // vs "View Artist Page" link — a profile read is the natural place a
    // visitor discovers someone has an artist page, so resolving it here
    // (one indexed lookup) beats making the frontend fire a second request
    // just to find out.
    const artist = await dbGetArtistByAccount(key);
    const artistStats = artist ? await dbGetLiveArtistStats(artist.id, await dbGetArtistStats(artist.id)) : null;
    const tracksUploaded = artist
      ? ((await supabase.from('tracks')
        .select('*', { count: 'exact', head: true })
        .eq('artist_id', artist.id)
        .eq('is_published', true)).count || 0)
      : 0;

    return res.json({
      username:            profile.username,
      displayName:         profile.display_name,
      avatarUrl:           profile.avatar_url,
      coverImageUrl:       profile.cover_image_url,
      bio:                 profile.bio,
      isPublic:            profile.is_public,
      joinedAt:            profile.created_at,
      followerCount:       profile.follower_count,
      followingCount:      profile.following_count,
      publicPlaylistCount: profile.public_playlist_count,
      totalPlays:          Number(profile.total_plays) || 0,
      totalLikesReceived:  profile.total_likes_received || 0,
      isArtist:            !!artist,
      artistSlug:          artist ? artist.slug : null,
      artistId:            artist ? artist.id : null,
      artistFollowerCount: artistStats ? artistStats.followerCount : 0,
      artistTotalPlays:    artistStats ? artistStats.totalPlays : 0,
      tracksUploaded,
      isFollowing,
      isSelf: !!(sess && sess.username === key),
    });
  } catch (err) {
    console.error('[profiles get]', err);
    return res.status(500).json({ error: 'Could not load profile.' });
  }
});

app.patch('/api/profiles/me', rateLimit, async (req, res) => {
  const { token, bio, displayName, isPublic } = req.body;
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });

  const patch = {};
  if (bio !== undefined) {
    if (typeof bio !== 'string') return res.status(400).json({ error: '"bio" must be a string.' });
    const trimmed = bio.trim();
    if (trimmed.length > 280) return res.status(400).json({ error: 'Bio must be 280 characters or fewer.' });
    patch.bio = trimmed || null;
  }
  if (displayName !== undefined) {
    const trimmed = String(displayName).trim().slice(0, 60);
    if (!trimmed) return res.status(400).json({ error: 'Display name cannot be empty.' });
    patch.display_name = trimmed;
  }
  if (isPublic !== undefined) {
    if (typeof isPublic !== 'boolean') return res.status(400).json({ error: '"isPublic" must be a boolean.' });
    patch.is_public = isPublic;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    const updated = await dbUpdateProfile(sess.username, patch);
    return res.json({
      username:    updated.username,
      displayName: updated.display_name,
      bio:         updated.bio,
      isPublic:    updated.is_public,
    });
  } catch (err) {
    console.error('[profiles patch]', err);
    return res.status(500).json({ error: 'Could not update profile.' });
  }
});

// Profile avatar/cover upload — multipart, mirrors the cloud-files upload
// pattern but targets the public `media` bucket via uploadMediaImage()
// instead of the private cloud-audio bucket. Ownership is always resolved
// from the session token, never from anything the client claims, same
// discipline as every other mutating route in this file.
app.post('/api/profiles/me/avatar', rateLimit, imageUpload.single('file'), async (req, res) => {
  const sess = await dbGetSession(req.body?.token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  try {
    const avatarUrl = await uploadMediaImage(req.file, 'avatars', sess.username);
    await dbUpdateProfile(sess.username, { avatar_url: avatarUrl });
    return res.json({ avatarUrl });
  } catch (err) {
    console.error('[profile avatar upload]', err);
    return res.status(500).json({ error: 'Could not upload avatar.' });
  }
});

app.post('/api/profiles/me/cover', rateLimit, imageUpload.single('file'), async (req, res) => {
  const sess = await dbGetSession(req.body?.token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  try {
    const coverImageUrl = await uploadMediaImage(req.file, 'covers', sess.username);
    await dbUpdateProfile(sess.username, { cover_image_url: coverImageUrl });
    return res.json({ coverImageUrl });
  } catch (err) {
    console.error('[profile cover upload]', err);
    return res.status(500).json({ error: 'Could not upload cover image.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FOLLOWS — public, no RLS write policy (server-only via service key).
//  follower_count / following_count on `profiles` stay in sync via the
//  trg_follow_counts Postgres trigger — never recomputed here.
//
//  POST   /api/follows/:username             { token }  → follow
//  DELETE /api/follows/:username              { token }  → unfollow
//  GET    /api/follows/:username/followers    ?limit=&offset=
//  GET    /api/follows/:username/following    ?limit=&offset=
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/follows/:username', followRateLimit, async (req, res) => {
  const target = (req.params.username || '').trim().toLowerCase();
  const sess = req._followSession; // resolved by followRateLimit — avoids a second dbGetSession round-trip
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!target) return res.status(400).json({ error: 'Username required.' });
  if (sess.username === target) return res.status(400).json({ error: "You can't follow yourself." });

  try {
    const account = await dbGetAccount(target);
    if (!account) return res.status(404).json({ error: 'No account found with that username.' });

    const created = await dbFollowUser(sess.username, target);
    if (created) {
      dbWriteActivity('follow', sess.username, target, {
        followedUsername: target,
      });
    }
    const profile = await dbGetProfile(target);
    return res.status(created ? 201 : 200).json({
      following: true,
      followerCount: profile?.follower_count ?? null,
    });
  } catch (err) {
    console.error('[follows create]', err);
    return res.status(500).json({ error: 'Could not follow user.' });
  }
});

app.delete('/api/follows/:username', followRateLimit, async (req, res) => {
  const target = (req.params.username || '').trim().toLowerCase();
  const sess = req._followSession; // resolved by followRateLimit — avoids a second dbGetSession round-trip
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!target) return res.status(400).json({ error: 'Username required.' });

  try {
    await dbUnfollowUser(sess.username, target);
    const profile = await dbGetProfile(target);
    return res.json({
      following: false,
      followerCount: profile?.follower_count ?? null,
    });
  } catch (err) {
    console.error('[follows delete]', err);
    return res.status(500).json({ error: 'Could not unfollow user.' });
  }
});

// Followers/following lists only ever show public profiles, plus the
// requester's own profile if they happen to appear in their own list (e.g.
// viewing who follows you includes a private-profile follower's *public*
// fields only — we never leak someone's private bio/displayName choice
// through someone else's follower list. Simplest correct rule: filter to
// is_public, full stop, even for the list owner viewing their own followers.
app.get('/api/follows/:username/followers', async (req, res) => {
  const key = (req.params.username || '').trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'Username required.' });
  const limit  = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const rows = await dbGetFollowers(key, { limit, offset });
    return res.json({
      users: rows.map(p => ({
        username: p.username, displayName: p.display_name, bio: p.bio,
      })),
    });
  } catch (err) {
    console.error('[follows followers]', err);
    return res.status(500).json({ error: 'Could not load followers.' });
  }
});

app.get('/api/follows/:username/following', async (req, res) => {
  const key = (req.params.username || '').trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'Username required.' });
  const limit  = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const rows = await dbGetFollowing(key, { limit, offset });
    return res.json({
      users: rows.map(p => ({
        username: p.username, displayName: p.display_name, bio: p.bio,
      })),
    });
  } catch (err) {
    console.error('[follows following]', err);
    return res.status(500).json({ error: 'Could not load following.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PLAYLISTS v2 — relational playlists backing Public/Shared Playlists.
//  Separate from the legacy `playlists` JSON-blob table used by
//  /api/auth/sync — that table still owns the in-app queue/library sync
//  for now; new playlists created here are independent until a deliberate
//  migration/cutover, not silently merged with the old blob.
//
//  RLS on playlists_v2/playlist_tracks already grants public SELECT for
//  is_public=true rows (and their tracks) to the anon key — every route
//  below still goes through the service role, but a public playlist is
//  also directly readable via client-side Supabase calls if that's ever
//  useful for a future perf optimization.
//
//  POST   /api/playlists                         { token, name, description?, isPublic? }
//  GET    /api/playlists/:id                     ?token=   → 404 if private and not owner
//  PATCH  /api/playlists/:id                      { token, name?, description?, isPublic? }
//  DELETE /api/playlists/:id                      { token }
//  GET    /api/playlists/mine                     ?token=
//  GET    /api/profiles/:username/playlists       (public playlists only)
//
//  POST   /api/playlists/:id/tracks               { token, trackData }
//  DELETE /api/playlists/:id/tracks/:rowId        { token }
// ═══════════════════════════════════════════════════════════════════════════════

const PLAYLIST_NAME_MAX = 80;
const PLAYLIST_DESC_MAX = 280;

function validatePlaylistPatch(body) {
  const patch = {};
  if (body.name !== undefined) {
    const trimmed = String(body.name).trim().slice(0, PLAYLIST_NAME_MAX);
    if (!trimmed) return { error: 'Playlist name cannot be empty.' };
    patch.name = trimmed;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return { error: '"description" must be a string or null.' };
    }
    const trimmed = (body.description || '').trim();
    if (trimmed.length > PLAYLIST_DESC_MAX) {
      return { error: `Description must be ${PLAYLIST_DESC_MAX} characters or fewer.` };
    }
    patch.description = trimmed || null;
  }
  if (body.isPublic !== undefined) {
    if (typeof body.isPublic !== 'boolean') return { error: '"isPublic" must be a boolean.' };
    patch.is_public = body.isPublic;
  }
  return { patch };
}

app.post('/api/playlists', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });

  const name = String(req.body.name || '').trim().slice(0, PLAYLIST_NAME_MAX);
  if (!name) return res.status(400).json({ error: 'Playlist name is required.' });

  const { error: descErr, patch } = validatePlaylistPatch({ description: req.body.description, isPublic: req.body.isPublic });
  if (descErr) return res.status(400).json({ error: descErr });

  try {
    const playlist = await dbCreatePlaylist(sess.username, {
      name, description: patch.description, isPublic: patch.is_public,
    });
    if (playlist.is_public) {
      dbWriteActivity('playlist_created', sess.username, null, {
        playlistId: playlist.id, playlistName: playlist.name,
      });
    }
    return res.status(201).json({
      id: playlist.id, owner: playlist.owner, name: playlist.name,
      description: playlist.description, isPublic: playlist.is_public,
      trackCount: playlist.track_count,
    });
  } catch (err) {
    console.error('[playlists create]', err);
    return res.status(500).json({ error: 'Could not create playlist.' });
  }
});

app.get('/api/playlists/mine', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const rows = await dbGetUserPlaylists(sess.username);
    return res.json({
      playlists: rows.map(p => ({
        id: p.id, name: p.name, description: p.description,
        isPublic: p.is_public, trackCount: p.track_count, likeCount: p.like_count || 0,
        updatedAt: p.updated_at,
      })),
    });
  } catch (err) {
    console.error('[playlists mine]', err);
    return res.status(500).json({ error: 'Could not load your playlists.' });
  }
});

// Private playlist + non-owner request → 404, not 403, matching the
// profiles pattern exactly: existence of a private playlist must not be
// distinguishable from "no playlist with that id" by an unauthenticated
// or non-owner request.

app.patch('/api/playlists/:id', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });

  const { error, patch } = validatePlaylistPatch(req.body);
  if (error) return res.status(400).json({ error });
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    const updated = await dbUpdatePlaylistMeta(req.params.id, sess.username, patch);
    if (!updated) return res.status(404).json({ error: 'Playlist not found.' });
    if (updated.is_public) {
      dbWriteActivity('playlist_updated', sess.username, null, {
        playlistId: updated.id, playlistName: updated.name,
      });
    }
    return res.json({
      id: updated.id, name: updated.name, description: updated.description,
      isPublic: updated.is_public, trackCount: updated.track_count,
    });
  } catch (err) {
    console.error('[playlists patch]', err);
    return res.status(500).json({ error: 'Could not update playlist.' });
  }
});

app.delete('/api/playlists/:id', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    await dbDeletePlaylist(req.params.id, sess.username);
    return res.json({ deleted: true });
  } catch (err) {
    console.error('[playlists delete]', err);
    return res.status(500).json({ error: 'Could not delete playlist.' });
  }
});

app.post('/api/playlists/:id/tracks', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  const { trackData } = req.body;
  if (!trackData || typeof trackData !== 'object') {
    return res.status(400).json({ error: '"trackData" object is required.' });
  }
  try {
    // Ownership OR editor-role check — editors can add tracks too.
    // dbAddTrackToPlaylist's track_count update is owner-scoped, so we pass
    // the real owner's username for that UPDATE; `addedBy` captures who
    // actually added the track for display in the collaborator track list.
    const playlist = await dbGetPlaylist(req.params.id);
    const editorRole = playlist && sess && (
      playlist.owner === sess.username ||
      await dbGetCollabRole(req.params.id, sess.username) === 'editor'
    );
    if (!playlist || !editorRole) {
      return res.status(404).json({ error: 'Playlist not found.' });
    }
    const row = await dbAddTrackToPlaylist(req.params.id, playlist.owner, trackData, sess.username);
    // Emit activity when a collaborator (non-owner) adds a track, or it's a public playlist
    if (playlist.is_public || sess.username !== playlist.owner) {
      dbWriteActivity('track_added', sess.username, playlist.owner !== sess.username ? playlist.owner : null, {
        playlistId: playlist.id, playlistName: playlist.name,
        trackTitle: trackData.title || trackData.id || 'Untitled',
        trackPlatform: trackData.platform || null,
      });
    }
    return res.status(201).json({ rowId: row.id, position: row.position });
  } catch (err) {
    console.error('[playlists add track]', err);
    return res.status(500).json({ error: 'Could not add track.' });
  }
});

app.delete('/api/playlists/:id/tracks/:rowId', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const playlist = await dbGetPlaylist(req.params.id);
    const editorRole = playlist && sess && (
      playlist.owner === sess.username ||
      await dbGetCollabRole(req.params.id, sess.username) === 'editor'
    );
    if (!playlist || !editorRole) {
      return res.status(404).json({ error: 'Playlist not found.' });
    }
    await dbRemoveTrackFromPlaylist(req.params.id, playlist.owner, req.params.rowId);
    return res.json({ removed: true });
  } catch (err) {
    console.error('[playlists remove track]', err);
    return res.status(500).json({ error: 'Could not remove track.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PLAYLIST LIKES
//  POST    /api/playlists/:id/like     { token }  → like (idempotent)
//  DELETE  /api/playlists/:id/like     { token }  → unlike (idempotent)
//  GET     /api/playlists/liked        ?token=    → playlists I've liked
//
//  Liking is only permitted on playlists the caller can actually see —
//  public playlists for anyone, or private/shared playlists for the owner
//  and accepted collaborators — using the exact same canView logic as
//  GET /api/playlists/:id, so a like can never be used to fish for whether
//  a private playlist id exists.
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/playlists/:id/like', likeRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const playlist = await dbGetPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

    const isOwner = playlist.owner === sess.username;
    const collabRole = !isOwner ? await dbGetCollabRole(req.params.id, sess.username) : null;
    const canView = isOwner || collabRole !== null || playlist.is_public;
    if (!canView) return res.status(404).json({ error: 'Playlist not found.' });

    const likeCount = await dbLikePlaylist(req.params.id, sess.username);
    if (playlist.is_public && !isOwner) {
      dbWriteActivity('playlist_liked', sess.username, playlist.owner, {
        playlistId: playlist.id, playlistName: playlist.name,
      });
    }
    return res.json({ liked: true, likeCount });
  } catch (err) {
    console.error('[playlists like]', err);
    return res.status(500).json({ error: 'Could not like playlist.' });
  }
});

app.delete('/api/playlists/:id/like', likeRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const likeCount = await dbUnlikePlaylist(req.params.id, sess.username);
    return res.json({ liked: false, likeCount });
  } catch (err) {
    console.error('[playlists unlike]', err);
    return res.status(500).json({ error: 'Could not unlike playlist.' });
  }
});

// Pending invites waiting for the current user (MUST be before :id routes) ----
app.get('/api/playlists/invites/mine', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const invites = await dbGetMyPendingInvites(sess.username);
    return res.json({ invites });
  } catch (err) {
    return res.status(500).json({ error: 'Could not load invites.' });
  }
});

app.get('/api/playlists/liked', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const playlists = await dbGetLikedPlaylists(sess.username);
    return res.json({ playlists });
  } catch (err) {
    console.error('[playlists liked]', err);
    return res.status(500).json({ error: 'Could not load liked playlists.' });
  }
});

// Playlists shared with the current user (accepted collabs) -------------------
app.get('/api/playlists/shared-with-me', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const playlists = await dbGetSharedWithMe(sess.username);
    return res.json({ playlists });
  } catch (err) {
    return res.status(500).json({ error: 'Could not load shared playlists.' });
  }
});

app.get('/api/playlists/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const playlist = await dbGetPlaylist(id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    const sess  = await dbGetSession(token);
    const isOwner = !!(sess && sess.username === playlist.owner);
    const collabRole = (!isOwner && sess)
      ? await dbGetCollabRole(id, sess.username)
      : null;
    const isEditor = isOwner || collabRole === 'editor';
    const canView  = isOwner || collabRole !== null || playlist.is_public;

    if (!canView) {
      return res.status(404).json({ error: 'Playlist not found.' });
    }

    const tracks = await dbGetPlaylistTracks(id);
    let collaborators = [];
    let pendingInvites = [];
    if (isOwner) {
      [collaborators, pendingInvites] = await Promise.all([
        dbGetCollaborators(id),
        dbGetPendingInvites(id),
      ]);
    } else if (collabRole) {
      collaborators = await dbGetCollaborators(id);
    }
    const likedByMe = sess ? await dbHasLiked(id, sess.username) : false;
    return res.json({
      id: playlist.id, owner: playlist.owner, name: playlist.name,
      description: playlist.description, isPublic: playlist.is_public,
      trackCount: playlist.track_count, isOwner,
      likeCount: playlist.like_count || 0, likedByMe,
      collabRole: collabRole || null, isEditor,
      collaborators, pendingInvites,
      tracks: tracks.map(t => ({
        rowId: t.id, ...t.track_data, addedBy: t.added_by, addedAt: t.added_at,
      })),
    });
  } catch (err) {
    console.error('[playlists get]', err);
    return res.status(500).json({ error: 'Could not load playlist.' });
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
//  COMMUNITY CHARTS — play tracking + rankings
//  POST /api/plays                { originalUrl, platform?, title?, token? }
//  GET  /api/charts/tracks         ?window=all|7d&limit=
//
//  Logging a play does NOT require auth — anonymous listeners count toward
//  Charts too, same as a real radio audience. token is optional; when
//  present and valid it attaches a username to the track_plays row (purely
//  informational, no per-user feature reads this yet) and is included in
//  the cooldown key so a signed-in listener's cooldown follows them across
//  IP changes. When absent, the IP is used as the cooldown key instead.
//
//  This route deliberately sits on the generic per-IP `rateLimit` (120/min)
//  rather than a bespoke limiter — same tier as /api/resolve and
//  /api/import, the other anonymous-allowed write-ish endpoints in this
//  file. The real anti-gaming guard is the 30s per-(track,listener)
//  cooldown inside dbLogPlay, not this outer rate limit.
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plays', rateLimit, async (req, res) => {
  const { originalUrl, platform, title, artist, token } = req.body || {};
  if (!originalUrl || typeof originalUrl !== 'string') {
    return res.status(400).json({ error: '"originalUrl" is required.' });
  }
  try {
    const sess = token ? await dbGetSession(token) : null;
    const listenerKey = sess ? sess.username : (req.ip || req.connection.remoteAddress || 'unknown');

    // For cloud: URLs (published FREQ tracks), the artist name is already on
    // the tracks row. If the caller didn't supply it (the frontend only
    // sends item.artist which is the ID3 field, not always set on cloud items),
    // we look it up from the existing tracks row so artist_id backfill never
    // silently fails for published music.
    let artistName = (typeof artist === 'string' && artist.trim()) ? artist.trim() : null;
    if (!artistName && typeof originalUrl === 'string' && originalUrl.startsWith('cloud:')) {
      const { data: existingTrack } = await supabase
        .from('tracks').select('artist_name').eq('original_url', originalUrl).maybeSingle();
      if (existingTrack?.artist_name) artistName = existingTrack.artist_name;
    }

    const result = await dbLogPlay(originalUrl, {
      platform: platform || null,
      title: title || null,
      artistName,
      username: sess ? sess.username : null,
      listenerKey,
    });
    if (!result) return res.status(500).json({ error: 'Could not log play.' });
    return res.json({ counted: result.counted, playCount: result.playCount ?? null });
  } catch (err) {
    console.error('[plays log]', err);
    return res.status(500).json({ error: 'Could not log play.' });
  }
});

const CHARTS_MAX_LIMIT = 100;

app.get('/api/charts/tracks', async (req, res) => {
  const window = req.query.window === '7d' ? '7d' : 'all';
  const limit  = Math.min(Math.max(Number(req.query.limit) || 50, 1), CHARTS_MAX_LIMIT);
  try {
    const rows = await dbGetTopTracks({ window, limit });
    const collabsByTrack = await dbGetCollaboratorsForTracks(rows.map(t => t.id));
    return res.json({
      window,
      tracks: rows.map((t, i) => ({
        rank: i + 1,
        id: t.id,
        originalUrl: t.original_url,
        platform: t.platform,
        title: t.title || t.original_url,
        playCount: window === '7d' ? t.play_count_7d : t.play_count,
        allTimePlayCount: t.play_count,
        lastPlayedAt: t.last_played_at,
        coverUrl: t.cover_url || null,
        artistId: t.artist_id || null,
        artistName: t.artist_name || null,
        collaborators: (collabsByTrack.get(t.id) || []).map(shapeCollaborator),
      })),
    });
  } catch (err) {
    console.error('[charts tracks]', err);
    return res.status(500).json({ error: 'Could not load charts.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DISCOVERY
//  GET /api/discover/playlists   ?sort=likes|recent&limit=
//  GET /api/discover/profiles    ?limit=&token=
//
//  Both are read-only and intentionally unauthenticated-friendly — Discovery
//  is meant to work for a visitor who hasn't signed in yet, same philosophy
//  as Charts. token on /profiles is optional and only used to exclude the
//  requester's own profile from the result (see dbDiscoverProfiles).
// ═══════════════════════════════════════════════════════════════════════════════

const DISCOVER_MAX_LIMIT = 50;

app.get('/api/discover/playlists', async (req, res) => {
  const sort  = req.query.sort === 'recent' ? 'recent' : 'likes';
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), DISCOVER_MAX_LIMIT);
  try {
    const rows = await dbDiscoverPlaylists({ sort, limit });
    return res.json({
      sort,
      playlists: rows.map(p => ({
        id: p.id, owner: p.owner, name: p.name, description: p.description,
        trackCount: p.track_count, likeCount: p.like_count || 0,
        updatedAt: p.updated_at,
      })),
    });
  } catch (err) {
    console.error('[discover playlists]', err);
    return res.status(500).json({ error: 'Could not load discovery playlists.' });
  }
});

app.get('/api/discover/profiles', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), DISCOVER_MAX_LIMIT);
  try {
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    const sess  = token ? await dbGetSession(token) : null;
    const rows  = await dbDiscoverProfiles({ limit, excludeUsername: sess ? sess.username : null });
    return res.json({
      profiles: rows.map(p => ({
        username: p.username, displayName: p.display_name, bio: p.bio,
        followerCount: p.follower_count, followingCount: p.following_count,
      })),
    });
  } catch (err) {
    console.error('[discover profiles]', err);
    return res.status(500).json({ error: 'Could not load discovery profiles.' });
  }
});

// ?mode=trending|new|search (default trending). search requires ?q=.
// Unauthenticated-friendly like every other Discovery route — same
// philosophy as Charts, this is meant to work for a visitor browsing
// before signing in.
app.get('/api/discover/artists', async (req, res) => {
  const mode  = ['trending', 'new', 'search'].includes(req.query.mode) ? req.query.mode : 'trending';
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), DISCOVER_MAX_LIMIT);
  const query = (req.query.q || '').toString().trim().slice(0, 100) || null;
  if (mode === 'search' && !query) return res.json({ mode, artists: [] });
  try {
    const rows = await dbDiscoverArtists({ mode, limit, query });
    return res.json({
      mode,
      artists: rows.map(a => {
        const stats = a.artist_stats || {};
        return {
          id: a.id, slug: a.slug, name: a.name,
          avatarUrl: a.avatar_url, bannerUrl: a.banner_url,
          isVerified: a.is_verified, followerCount: a.follower_count,
          createdAt: a.created_at,
          isNew: (Date.now() - new Date(a.created_at).getTime()) < NEW_ARTIST_WINDOW_DAYS * 24 * 60 * 60 * 1000,
          totalPlays: Number(stats.total_plays) || 0,
          totalPlays7d: stats.total_plays_7d || 0,
          monthlyListeners: stats.monthly_listeners || 0,
          chartRank: stats.chart_rank ?? null,
        };
      }),
    });
  } catch (err) {
    console.error('[discover artists]', err);
    return res.status(500).json({ error: 'Could not load discovery artists.' });
  }
});

// ─── Activity Feed DB helpers ─────────────────────────────────────────────────
// event_type values in use:
//   follow | collab_joined | track_added | playlist_created | playlist_updated
//   | playlist_liked
// (No DB-level CHECK constraint enforces this list — it's a convention
// followed by every dbWriteActivity call site in this file.)
//
// actor      = who did the thing
// target_user = who should see it in their personal feed
//               (NULL = global-only event; personal events always also appear globally)
// payload    = JSONB with event-specific fields, stored in the `meta` column
//              (the column is named meta, not payload — the parameter here
//              is named payload for readability at every call site, but it
//              must be written to .insert({ meta: payload }), not
//              { payload }. A prior version of this function wrote
//              { payload } directly, which silently failed on every single
//              call — Postgres/PostgREST has no `payload` column on
//              activity_feed to write to. This was confirmed live: 2 real
//              follow relationships existed in `follows` with zero
//              corresponding rows in `activity_feed`. Every dbWriteActivity
//              call in this file was failing silently before this fix.)

async function dbWriteActivity(eventType, actor, targetUser, payload = {}) {
  // Fire-and-forget — never block a route on feed writes.
  supabase.from('activity_feed').insert({
    event_type: eventType,
    actor,
    target_user: targetUser || null,
    meta: payload,
  }).then(({ error }) => {
    if (error) console.error('[activity write]', eventType, error.message);
  });
}

// Artist-originated events (new release, an artist's track went viral,
// etc) have no real account behind an unclaimed artist, and even a claimed
// one's activity here is artist-centric rather than user-centric — "Slimey
// dropped a new EP" reads as an artist action, not a personal one, even on
// a claimed page. So `actor` is set to a synthetic, never-a-real-username
// marker (artist:<uuid>) rather than left null or pointing at the claiming
// account, and meta.artistId carries the real link. dbGetFollowingFeed's
// meta->>artistId clause is what actually surfaces these to followers —
// the synthetic actor value is never matched against `follows`, by design,
// since an artist isn't a row in `accounts` and never will be for
// unclaimed artists.
async function dbWriteArtistActivity(eventType, artistId, payload = {}) {
  await dbWriteActivity(eventType, `artist:${artistId}`, null, { ...payload, artistId });
}

// Following feed: events where actor is someone `username` follows, OR
// target_user === username, OR the event's meta.artistId is an artist
// `username` follows. That last clause is new specifically for Artist
// Pages: artist-originated events (new release, etc) have no `actor`
// username to match against follows (an unclaimed artist has no account at
// all, and even a claimed one's activity is written as artist-centric, not
// user-centric — see dbWriteArtistActivity below) — without this clause,
// following an artist would never surface anything in this feed, only on
// the artist's own page, which defeats the point of "integrate with the
// existing Activity Feed system" for the personal/following view.
async function dbGetFollowingFeed(username, { limit = 30, before = null } = {}) {
  // Get the list of people this user follows
  const { data: followRows } = await supabase
    .from('follows')
    .select('followed_username')
    .eq('follower_username', username);
  const following = (followRows || []).map(r => r.followed_username);

  const { data: artistFollowRows } = await supabase
    .from('artist_followers')
    .select('artist_id')
    .eq('follower_username', username);
  const followedArtistIds = (artistFollowRows || []).map(r => r.artist_id);

  // Include events targeted at `username` directly (e.g. someone followed you)
  // plus events from people they follow, plus events from artists they follow
  let q = supabase
    .from('activity_feed')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) q = q.lt('created_at', before);

  const orClauses = [];
  if (following.length) orClauses.push(`actor.in.(${following.map(u => `"${u}"`).join(',')})`);
  orClauses.push(`target_user.eq.${username}`);
  if (followedArtistIds.length) orClauses.push(`meta->>artistId.in.(${followedArtistIds.map(id => `"${id}"`).join(',')})`);
  q = q.or(orClauses.join(','));

  const { data, error } = await q;
  if (error) { console.error('[activity following feed]', error.message); return []; }
  return data || [];
}

async function dbGetGlobalFeed({ limit = 30, before = null } = {}) {
  let q = supabase
    .from('activity_feed')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) { console.error('[activity global feed]', error.message); return []; }
  return data || [];
}

async function dbGetUnreadCount(username, since) {
  // Unread = events in the following feed newer than `since`
  const { data: followRows } = await supabase
    .from('follows')
    .select('followed_username')
    .eq('follower_username', username);
  const following = (followRows || []).map(r => r.followed_username);
  let q = supabase
    .from('activity_feed')
    .select('id', { count: 'exact', head: true })
    .gt('created_at', since);
  if (following.length) {
    q = q.or(`actor.in.(${following.map(u => `"${u}"`).join(',')}),target_user.eq.${username}`);
  } else {
    q = q.eq('target_user', username);
  }
  const { count } = await q;
  return count || 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHARED PLAYLISTS — collaboration invites, roles, realtime SSE
//
//  POST   /api/playlists/:id/collaborators          { token, username, role }
//  GET    /api/playlists/:id/collaborators          ?token=
//  PATCH  /api/playlists/:id/collaborators/:user    { token, role }
//  DELETE /api/playlists/:id/collaborators/:user    { token }
//
//  POST   /api/playlists/:id/invites/accept/:inviteId  { token }
//  POST   /api/playlists/:id/invites/decline/:inviteId { token }
//  DELETE /api/playlists/:id/invites/:inviteId         { token }  (owner cancel)
//
//  GET    /api/playlists/invites/mine               ?token=   → pending invites for me
//  GET    /api/playlists/shared-with-me             ?token=   → playlists I'm a collaborator on
//
//  GET    /api/playlists/:id/realtime               SSE stream for track + collab changes
// ═══════════════════════════════════════════════════════════════════════════════

// Invite a user to collaborate -------------------------------------------------
app.post('/api/playlists/:id/collaborators', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  const { username, role = 'viewer' } = req.body;
  if (!username) return res.status(400).json({ error: '"username" is required.' });
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be "editor" or "viewer".' });
  const pl = await dbGetPlaylist(req.params.id);
  if (!pl || pl.owner !== sess.username) return res.status(404).json({ error: 'Playlist not found.' });
  // Verify the invitee exists
  const invitee = username.trim().toLowerCase();
  const inviteeProfile = await dbGetProfile(invitee);
  if (!inviteeProfile) return res.status(404).json({ error: `User @${invitee} not found.` });
  try {
    const invite = await dbInviteCollaborator(req.params.id, sess.username, invitee, role);
    return res.status(201).json({ inviteId: invite.id, invitee, role, status: 'pending' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// List collaborators (+ pending invites for owner) ----------------------------
app.get('/api/playlists/:id/collaborators', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  const pl = await dbGetPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found.' });
  const role = await dbGetCollabRole(req.params.id, sess.username);
  if (!role) return res.status(404).json({ error: 'Playlist not found.' });
  const collaborators = await dbGetCollaborators(req.params.id);
  const pendingInvites = role === 'owner' ? await dbGetPendingInvites(req.params.id) : [];
  return res.json({ collaborators, pendingInvites });
});

// Update a collaborator's role ------------------------------------------------
app.patch('/api/playlists/:id/collaborators/:user', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  const { role } = req.body;
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be "editor" or "viewer".' });
  try {
    await dbUpdateCollaboratorRole(req.params.id, sess.username, req.params.user, role);
    return res.json({ updated: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// Remove a collaborator (owner only) ------------------------------------------
app.delete('/api/playlists/:id/collaborators/:user', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    await dbRemoveCollaborator(req.params.id, sess.username, req.params.user);
    return res.json({ removed: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// Accept an invite ------------------------------------------------------------
app.post('/api/playlists/:id/invites/accept/:inviteId', async (req, res) => {
  const { token } = req.body;
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const result = await dbAcceptInvite(req.params.inviteId, sess.username);
    // Notify the playlist owner and broadcast globally
    const joinedPlaylist = await dbGetPlaylist(result.playlistId);
    if (joinedPlaylist) {
      dbWriteActivity('collab_joined', sess.username, joinedPlaylist.owner, {
        playlistId: result.playlistId,
        playlistName: joinedPlaylist.name,
        role: result.role,
      });
    }
    return res.json({ accepted: true, ...result });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Decline an invite (invitee) / cancel (owner) --------------------------------
app.post('/api/playlists/:id/invites/decline/:inviteId', async (req, res) => {
  const { token } = req.body;
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    await dbDeclineInvite(req.params.inviteId, sess.username);
    return res.json({ declined: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Owner cancel pending invite -------------------------------------------------
app.delete('/api/playlists/:id/invites/:inviteId', playlistRateLimit, async (req, res) => {
  const sess = req._session;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    await dbDeclineInvite(req.params.inviteId, sess.username);
    return res.json({ cancelled: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// Pending invites waiting for the current user --------------------------------
// ─── Realtime SSE fan-out ────────────────────────────────────────────────────
// Clients subscribe to GET /api/playlists/:id/realtime (SSE). The server holds
// a Supabase Realtime channel per playlist-id and fans out track + collaborator
// change events to all connected browsers. No anon key is shipped to the client.

const playlistSseClients = new Map(); // playlistId → Set<res>
const playlistRealtimeChannels = new Map(); // playlistId → supabase channel

function getOrCreateRealtimeChannel(playlistId) {
  if (playlistRealtimeChannels.has(playlistId)) return;
  const channel = supabase
    .channel(`playlist:${playlistId}`)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'playlist_tracks', filter: `playlist_id=eq.${playlistId}` },
        (payload) => broadcastToPlaylist(playlistId, { type: 'tracks', payload }))
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'playlist_collaborators', filter: `playlist_id=eq.${playlistId}` },
        (payload) => broadcastToPlaylist(playlistId, { type: 'collaborators', payload }))
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'playlist_invites', filter: `playlist_id=eq.${playlistId}` },
        (payload) => broadcastToPlaylist(playlistId, { type: 'invites', payload }))
    .subscribe();
  playlistRealtimeChannels.set(playlistId, channel);
}

function broadcastToPlaylist(playlistId, data) {
  const clients = playlistSseClients.get(playlistId);
  if (!clients || !clients.size) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { /* client disconnected */ }
  }
}

function removeSseClient(playlistId, res) {
  const clients = playlistSseClients.get(playlistId);
  if (!clients) return;
  clients.delete(res);
  if (!clients.size) {
    // No more listeners — tear down the Supabase channel to free resources.
    const ch = playlistRealtimeChannels.get(playlistId);
    if (ch) { supabase.removeChannel(ch); playlistRealtimeChannels.delete(playlistId); }
    playlistSseClients.delete(playlistId);
  }
}

app.get('/api/playlists/:id/realtime', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).end();

  const { id } = req.params;
  const pl = await dbGetPlaylist(id);
  const role = pl ? await dbGetCollabRole(id, sess.username) : null;
  // Must be owner, collaborator, OR viewing a public playlist to subscribe.
  if (!pl || (!role && !pl.is_public)) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  if (!playlistSseClients.has(id)) playlistSseClients.set(id, new Set());
  playlistSseClients.get(id).add(res);
  getOrCreateRealtimeChannel(id);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(id, res);
  });
});

// Public playlists for a profile — mounted under /api/profiles so it reads
// naturally from the profile viewer, but intentionally returns [] (not 404)
// for a private or nonexistent profile rather than erroring, since the
// profile route itself is what's responsible for surfacing "this profile
// doesn't exist/isn't public" — this endpoint is always a secondary call
// made after that check already passed.
app.get('/api/profiles/:username/playlists', async (req, res) => {
  const key = (req.params.username || '').trim().toLowerCase();
  if (!key) return res.json({ playlists: [] });
  try {
    const rows = await dbGetPublicPlaylistsForUser(key);
    return res.json({
      playlists: rows.map(p => ({
        id: p.id, name: p.name, description: p.description, trackCount: p.track_count,
        likeCount: p.like_count || 0,
      })),
    });
  } catch (err) {
    console.error('[profile playlists]', err);
    return res.json({ playlists: [] });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CLOUD FILES  — Supabase Storage (private bucket) + Postgres metadata
//  POST   /api/cloud-files        { token, filename, mimeType, data }  data = base64 data URL
//  GET    /api/cloud-files        ?token=...   → list of { id, filename, size, mimeType, uploadedAt }
//  GET    /api/cloud-files/:id    ?token=...   → { ...metadata, url } url = short-lived signed URL
//  DELETE /api/cloud-files/:id    { token }
// ═══════════════════════════════════════════════════════════════════════════════

const CLOUD_FILE_MAX_BYTES = 20 * 1048576; // 20MB, matches client-side cap
const SIGNED_URL_TTL_SECONDS = 60 * 10;    // 10 minutes — long enough to start playback, short enough to limit exposure if a link leaks

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// Folders are a flat, single-level string per file (no nested paths).
// Trims whitespace, collapses internal whitespace, caps length, and
// treats empty string the same as "no folder" (stored as null).
function normalizeFolderName(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/\s+/g, ' ').slice(0, 100);
  return cleaned || null;
}

app.post('/api/cloud-files', rateLimit, (req, res, next) => {
  // ── multipart path (new) ──────────────────────────────────────────────────
  // Content-Type: multipart/form-data  →  fields: token, filename(optional)
  //                                        file:   the audio file
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    upload.single('file')(req, res, async (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: 'File exceeds 20 MB limit.' });
      if (err) return res.status(400).json({ error: err.message });

      const token    = req.body.token || (req.headers.authorization || '').replace('Bearer ', '');
      const sess     = await dbGetSession(token);
      if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });

      if (!req.file) return res.status(400).json({ error: 'No file received.' });

      const originalName = req.body.filename || req.file.originalname || 'audio';
      const mimeType     = req.file.mimetype === 'application/octet-stream'
        ? guessMimeFromName(originalName)
        : req.file.mimetype;

      const safeName    = String(originalName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-150);
      const storagePath = `${sess.username}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;

      // Optional ID3 metadata, read client-side and sent alongside the file.
      // All are optional — anything missing just lands as null in the row.
      const folder   = normalizeFolderName(req.body.folder);
      const title    = (req.body.title  || '').trim().slice(0, 255) || null;
      const artist   = (req.body.artist || '').trim().slice(0, 255) || null;
      const duration = req.body.duration != null && req.body.duration !== ''
        ? Number(req.body.duration) : null;

      try {
        const uploadResult = await supabase.storage
          .from(CLOUD_BUCKET)
          .upload(storagePath, req.file.buffer, {
            contentType: mimeType,
            upsert: false,
          });
        if (uploadResult.error) throw new Error(uploadResult.error.message);

        const row = await dbInsertCloudFile({
          owner:        sess.username,
          filename:     String(originalName).slice(0, 255),
          mime_type:    mimeType,
          size:         req.file.size,
          storage_path: storagePath,
          uploaded_at:  new Date().toISOString(),
          folder, title, artist,
          duration: (duration != null && Number.isFinite(duration)) ? duration : null,
        });

        return res.status(201).json({
          id: row.id, filename: row.filename, size: row.size,
          mimeType: row.mime_type, uploadedAt: row.uploaded_at,
          folder: row.folder, title: row.title, artist: row.artist, duration: row.duration,
        });
      } catch (e) {
        console.error('[cloud-files multipart upload]', e);
        return res.status(500).json({ error: 'Upload failed: ' + e.message });
      }
    });
    return; // multer handles the response above
  }

  // ── base64 / JSON path (legacy fallback) ─────────────────────────────────
  // Content-Type: application/json  →  { token, filename, data: "data:audio/...;base64,..." }
  next();
}, async (req, res) => {
  const { token, filename, data, folder, title, artist, duration } = req.body;
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!filename || !data) return res.status(400).json({ error: '"filename" and "data" are required.' });

  const parsed = parseDataUrl(data);
  if (!parsed) return res.status(400).json({ error: '"data" must be a base64 data URL.' });
  if (parsed.buffer.length > CLOUD_FILE_MAX_BYTES)
    return res.status(413).json({ error: `File exceeds ${CLOUD_FILE_MAX_BYTES / 1048576}MB limit.` });

  const safeName    = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-150);
  const storagePath = `${sess.username}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;

  const folderClean   = normalizeFolderName(folder);
  const titleClean    = (title  || '').trim().slice(0, 255) || null;
  const artistClean   = (artist || '').trim().slice(0, 255) || null;
  const durationClean = duration != null && duration !== '' && Number.isFinite(Number(duration))
    ? Number(duration) : null;

  try {
    const { error: uploadErr } = await supabase.storage
      .from(CLOUD_BUCKET)
      .upload(storagePath, parsed.buffer, { contentType: parsed.mimeType, upsert: false });
    if (uploadErr) throw new Error(uploadErr.message);

    const row = await dbInsertCloudFile({
      owner: sess.username,
      filename: String(filename).slice(0, 255),
      mime_type: parsed.mimeType,
      size: parsed.buffer.length,
      storage_path: storagePath,
      uploaded_at: new Date().toISOString(),
      folder: folderClean, title: titleClean, artist: artistClean, duration: durationClean,
    });

    return res.status(201).json({
      id: row.id, filename: row.filename, size: row.size,
      mimeType: row.mime_type, uploadedAt: row.uploaded_at,
      folder: row.folder, title: row.title, artist: row.artist, duration: row.duration,
    });
  } catch (err) {
    console.error('[cloud-files upload]', err);
    return res.status(500).json({ error: 'Upload failed.' });
  }
});

app.get('/api/cloud-files', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    // folder: omit = all files; '' or '__unfiled__' = no-folder files only; '<name>' = that folder
    // search: full-text match against filename / title / artist (single page, not paginated)
    // sort:   name | artist | date | duration   (default: date)
    // dir:    asc | desc                        (default: desc)
    // cursor: opaque string from a previous response's nextCursor — omit for page 1
    // limit:  page size, 1-200 (default: 50)
    const { rows, nextCursor } = await dbGetCloudFiles(sess.username, {
      folder: req.query.folder,
      search: (req.query.search || '').trim() || undefined,
      sort:   req.query.sort,
      dir:    req.query.dir,
      cursor: req.query.cursor || undefined,
      limit:  req.query.limit,
    });
    return res.json({
      files: rows.map(f => ({
        id: f.id, filename: f.filename, size: f.size,
        mimeType: f.mime_type, uploadedAt: f.uploaded_at,
        folder: f.folder, title: f.title, artist: f.artist, duration: f.duration,
      })),
      nextCursor,
    });
  } catch (err) {
    console.error('[cloud-files list]', err);
    return res.status(500).json({ error: 'Could not load cloud files.' });
  }
});

// GET /api/cloud-files/folders  — distinct folder names for the signed-in user,
// used to populate folder nav / a "move to folder" picker on the client.
// Registered before the /:id routes so 'folders' is never read as an id.
app.get('/api/cloud-files/folders', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const folders = await dbGetCloudFolders(sess.username);
    return res.json({ folders });
  } catch (err) {
    console.error('[cloud-files folders]', err);
    return res.status(500).json({ error: 'Could not load folders.' });
  }
});

// DELETE /api/cloud-files  { token, ids: [1,2,3] }  — bulk delete.
// Registered before /:id so this exact path (no id segment) matches first.
app.delete('/api/cloud-files', async (req, res) => {
  const token = req.body.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token.' });

  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(n => Number.isFinite(Number(n))) : [];
  if (!ids.length) return res.status(400).json({ error: '"ids" must be a non-empty array.' });

  try {
    // Resolve to rows the caller actually owns first — ids for someone else's
    // files (or ids that don't exist) are dropped here, not erred on, since a
    // mixed-ownership bulk request shouldn't fail the whole batch.
    const files = await dbGetCloudFilesByIds(ids, sess.username);
    if (!files.length) return res.status(404).json({ error: 'No matching files found.' });

    const paths = files.map(f => f.storage_path);
    const { error: removeErr } = await supabase.storage.from(CLOUD_BUCKET).remove(paths);
    if (removeErr) console.error('[cloud-files bulk delete] storage:', removeErr.message);

    await dbDeleteCloudFiles(files.map(f => f.id), sess.username);
    return res.json({ ok: true, deleted: files.length, filenames: files.map(f => f.filename) });
  } catch (err) {
    console.error('[cloud-files bulk delete]', err);
    return res.status(500).json({ error: 'Bulk delete failed.' });
  }
});

// PATCH /api/cloud-files/:id  { token, filename?, folder? }  — rename and/or move.
// Registered before the generic /:id GET/DELETE just for readability; method
// differs so there's no actual routing ambiguity.
app.patch('/api/cloud-files/:id', async (req, res) => {
  const token = req.body.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token.' });

  const patch = {};
  if (req.body.filename != null) {
    const name = String(req.body.filename).trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: 'Filename cannot be empty.' });
    patch.filename = name;
  }
  if (req.body.folder !== undefined) {
    patch.folder = normalizeFolderName(req.body.folder);
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    const existing = await dbGetCloudFile(req.params.id, sess.username);
    if (!existing) return res.status(404).json({ error: 'File not found.' });

    const row = await dbUpdateCloudFile(req.params.id, sess.username, patch);
    return res.json({
      id: row.id, filename: row.filename, folder: row.folder,
      title: row.title, artist: row.artist, duration: row.duration,
    });
  } catch (err) {
    console.error('[cloud-files patch]', err);
    return res.status(500).json({ error: 'Update failed.' });
  }
});

app.get('/api/cloud-files/:id', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    // .eq('owner', sess.username) is inside dbGetCloudFile itself — a file that
    // exists but belongs to someone else returns null here, identically to a
    // file that doesn't exist at all. No way to distinguish the two by probing.
    const file = await dbGetCloudFile(req.params.id, sess.username);
    if (!file) return res.status(404).json({ error: 'File not found.' });

    const { data, error } = await supabase.storage
      .from(CLOUD_BUCKET)
      .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error) throw new Error(error.message);

    return res.json({
      id: file.id, filename: file.filename, size: file.size,
      mimeType: file.mime_type, uploadedAt: file.uploaded_at,
      folder: file.folder, title: file.title, artist: file.artist, duration: file.duration,
      url: data.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS,
    });
  } catch (err) {
    console.error('[cloud-files signed-url]', err);
    return res.status(500).json({ error: 'Could not generate playback URL.' });
  }
});

app.delete('/api/cloud-files/:id', async (req, res) => {
  const token = req.body.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token.' });
  try {
    const file = await dbGetCloudFile(req.params.id, sess.username);
    if (!file) return res.status(404).json({ error: 'File not found.' });

    const { error: removeErr } = await supabase.storage.from(CLOUD_BUCKET).remove([file.storage_path]);
    if (removeErr) console.error('[cloud-files delete] storage:', removeErr.message);

    await dbDeleteCloudFile(req.params.id, sess.username);
    return res.json({ ok: true, deleted: file.filename });
  } catch (err) {
    console.error('[cloud-files delete]', err);
    return res.status(500).json({ error: 'Delete failed.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NAMED INDEXES  — server-curated playlists fetchable by slug
//  GET /api/index/:name  → { name, tracks: [...], total, fetchedAt }
//  GET /api/index        → { indexes: ['flex', ...] }
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Each entry is a resolved track object identical to what /api/resolve returns.
 * Add more named indexes below by adding a new key.
 */
const NAMED_INDEXES = {
  // Add named indexes here. Each key is the URL slug (e.g. 'flex', 'chill').
  // Tracks use the same shape as /api/resolve responses.
  //
  // Example:
  // flex: {
  //   label:       'FLEX',
  //   description: 'The FREQ FLEX showcase playlist.',
  //   tracks: [
  //     {
  //       platform: 'youtube', type: 'video', id: 'abc123',
  //       originalUrl: 'https://www.youtube.com/watch?v=abc123',
  //       embedUrl:    'https://www.youtube.com/embed/abc123?autoplay=1&controls=1&enablejsapi=1',
  //       embedUrlNC:  'https://www.youtube-nocookie.com/embed/abc123?autoplay=1&controls=1&enablejsapi=1',
  //       title:       'Track Title',
  //     },
  //   ],
  // },
};

// GET /api/index  — list all available named indexes
app.get('/api/index', (req, res) => {
  const indexes = Object.entries(NAMED_INDEXES).map(([slug, idx]) => ({
    slug,
    label:       idx.label,
    description: idx.description || '',
    total:       idx.tracks.length,
  }));
  return res.json({ indexes });
});

// GET /index  — alias for /api/index to support legacy or direct index routes
app.get('/index', (req, res) => {
  const indexes = Object.entries(NAMED_INDEXES).map(([slug, idx]) => ({
    slug,
    label:       idx.label,
    description: idx.description || '',
    total:       idx.tracks.length,
  }));
  return res.json({ indexes });
});

function getNamedIndexResponse(slug) {
  const idx = NAMED_INDEXES[slug];
  if (!idx) {
    return { status: 404, body: {
      error: `No index named "${slug}". Available: ${Object.keys(NAMED_INDEXES).join(', ')}`,
    } };
  }
  return { status: 200, body: {
    name:        slug,
    label:       idx.label,
    description: idx.description || '',
    tracks:      idx.tracks,
    total:       idx.tracks.length,
    fetchedAt:   Date.now(),
  } };
}

// GET /api/index/:name  — fetch a named index by slug
app.get('/api/index/:name', (req, res) => {
  const slug = req.params.name.toLowerCase().trim();
  const result = getNamedIndexResponse(slug);
  return res.status(result.status).json(result.body);
});

// GET /index/:name  — alias for /api/index/:name
app.get('/index/:name', (req, res) => {
  const slug = req.params.name.toLowerCase().trim();
  const result = getNamedIndexResponse(slug);
  return res.status(result.status).json(result.body);
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//  ACTIVITY FEED
//
//  GET /api/activity/feed          ?token= &scope=following|global &before=<ISO> &limit=<n>
//  GET /api/activity/feed/realtime                                                   SSE
//  GET /api/activity/unread        ?token= &since=<ISO>
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/activity/feed', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });

  const scope  = req.query.scope === 'global' ? 'global' : 'following';
  const before = req.query.before || null;
  const limit  = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

  try {
    const events = scope === 'global'
      ? await dbGetGlobalFeed({ limit, before })
      : await dbGetFollowingFeed(sess.username, { limit, before });

    return res.json({
      events: events.map(e => ({
        id: e.id,
        type: e.event_type,
        actor: e.actor,
        targetUser: e.target_user,
        payload: e.meta, // DB column is `meta`; API field stays `payload` for an unchanged public contract
        createdAt: e.created_at,
      })),
      nextCursor: events.length === limit ? events[events.length - 1].created_at : null,
    });
  } catch (err) {
    console.error('[activity feed]', err);
    return res.status(500).json({ error: 'Could not load activity feed.' });
  }
});

app.get('/api/activity/unread', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  const since = req.query.since;
  if (!since) return res.json({ count: 0 });
  try {
    const count = await dbGetUnreadCount(sess.username, since);
    return res.json({ count });
  } catch (err) {
    return res.json({ count: 0 });
  }
});

// ─── Activity SSE fan-out ──────────────────────────────────────────────────────
// One server-side Supabase Realtime channel for the activity_feed table.
// Browsers subscribe to /api/activity/feed/realtime and receive push notifications
// when new rows are inserted — they then re-fetch to stay in sync.

const activitySseClients = new Map(); // username → Set<res>
let activityRealtimeChannel = null;

function ensureActivityRealtimeChannel() {
  if (activityRealtimeChannel) return;
  activityRealtimeChannel = supabase
    .channel('activity_feed_global')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'activity_feed' },
        (payload) => {
          const row = payload.new;
          // Fan out to: the target_user (if set) + the actor's followers (approximated by
          // broadcasting to everyone and letting the client filter by scope).
          // Simpler and correct: broadcast to all connected SSE clients with the new event.
          const msg = `data: ${JSON.stringify({
            id: row.id, type: row.event_type, actor: row.actor,
            targetUser: row.target_user, payload: row.meta, createdAt: row.created_at,
          })}\n\n`;
          for (const clients of activitySseClients.values()) {
            for (const res of clients) {
              try { res.write(msg); } catch (_) {}
            }
          }
        })
    .subscribe();
}

function removeActivitySseClient(username, res) {
  const clients = activitySseClients.get(username);
  if (!clients) return;
  clients.delete(res);
  if (!clients.size) activitySseClients.delete(username);
  // If no more clients at all, tear down the realtime channel
  if (activitySseClients.size === 0 && activityRealtimeChannel) {
    supabase.removeChannel(activityRealtimeChannel);
    activityRealtimeChannel = null;
  }
}

app.get('/api/activity/feed/realtime', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = await dbGetSession(token);
  if (!sess) return res.status(401).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  if (!activitySseClients.has(sess.username)) activitySseClients.set(sess.username, new Set());
  activitySseClients.get(sess.username).add(res);
  ensureActivityRealtimeChannel();

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeActivitySseClient(sess.username, res);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ARTIST PAGES
//  GET    /api/artists                    ?sort=followers|trending|recent&search=&limit=&offset=
//  GET    /api/artists/:id                ?token=     (id = artists.id uuid, OR @username for a claimed page)
//  GET    /api/artists/:id/tracks         ?sort=plays|trending&limit=
//  GET    /api/artists/:id/releases       ?type=single|album|ep|mixtape
//  GET    /api/artists/:id/activity       ?limit=&before=
//  POST   /api/artists/:id/follow         { token }
//  DELETE /api/artists/:id/follow         { token }
//  PATCH  /api/artists/:id                { token, bio?, avatarUrl?, bannerUrl? }   (claimed-owner only)
//  POST   /api/artists/claim              { token, artistId }                      (link your account to an unclaimed artist)
//  POST   /api/artists/:id/releases       { token, title, releaseType, coverUrl?, releaseDate?, trackIds? } (claimed-owner only)
//
//  Every read route here is intentionally unauthenticated-friendly, same
//  philosophy as Charts and Discovery — an artist page is browsable by a
//  visitor who hasn't signed in. token is optional on GET routes and only
//  used to compute isFollowing/isOwner for the requester.
// ═══════════════════════════════════════════════════════════════════════════════

// Resolves the :id path param to an artists row. Supports four shapes:
//   - a bare artists.id (uuid)              -> dbGetArtistById
//   - "@username"                           -> dbGetArtistByAccount (claimed page, looked up by the claiming account)
//   - a bare username with no "@" that      -> falls back to dbGetArtistByAccount too, so
//     happens not to look like a uuid          /api/artists/slimey2017 and /api/artists/@slimey2017
//                                                both work without the caller needing to know which
//                                                form an id is in.
//   - a slug (artists.slug)                 -> dbGetArtistBySlug — the form /artist/:slug actually
//                                                routes with, and the only one that resolves
//                                                UNCLAIMED artists (no account_id, so no username to
//                                                look up by at all).
// This is the "single :id path param could plausibly be either" case the
// comment above dbGetArtist already flagged as a future need — implementing
// it at the route layer (rather than in dbGetArtist itself) keeps the DB
// helpers' contracts narrow and testable, and keeps this dual-lookup
// concern in exactly one place.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolveArtistFromParam(idParam) {
  const raw = decodeURIComponent(idParam || '').trim();
  if (!raw) return null;
  if (raw.startsWith('@')) return dbGetArtistByAccount(raw.slice(1).toLowerCase());
  if (UUID_RE.test(raw)) return dbGetArtistById(raw);
  // Not a uuid and no @ prefix — try slug first (the canonical /artist/:slug
  // form, and the only lookup that works for unclaimed artists), then fall
  // back to account username for the older /api/artists/slimey2017 convenience
  // form. Slug first because every artist has one (NOT NULL), while only
  // claimed artists have an account_id to match against.
  const bySlug = await dbGetArtistBySlug(raw.toLowerCase());
  if (bySlug) return bySlug;
  return dbGetArtistByAccount(raw.toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOCIAL POSTS SYSTEM
//
//  POST   /api/posts                    create a post (auth required)
//  GET    /api/posts                    global feed (paginated)
//  GET    /api/posts/user/:username     posts by a user
//  GET    /api/posts/:id                single post
//  PATCH  /api/posts/:id                edit post (owner only)
//  DELETE /api/posts/:id                delete post (owner only)
//  POST   /api/posts/:id/like           like a post
//  DELETE /api/posts/:id/like           unlike a post
//  POST   /api/posts/:id/comments       add comment
//  GET    /api/posts/:id/comments       list comments
//  DELETE /api/posts/:id/comments/:cid  delete comment (owner only)
// ═══════════════════════════════════════════════════════════════════════════════

// ── DB helpers ───────────────────────────────────────────────────────────────

async function dbCreatePost(username, { postType, body, playlistId, trackId, artistId, releaseId }) {
  const { data, error } = await supabase.from('posts').insert({
    author: username,
    post_type: postType || 'text',
    body: body || null,
    playlist_id: playlistId || null,
    track_id: trackId || null,
    artist_id: artistId || null,
    release_id: releaseId || null,
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function dbGetPost(postId) {
  const { data, error } = await supabase.from('posts')
    .select('*, profiles:author!inner(username, display_name, avatar_url), artists:artist_id(id, name, slug, avatar_url, is_verified)')
    .eq('id', postId).maybeSingle();
  if (error) { console.error('[db] getPost:', error.message); return null; }
  return data;
}

async function dbGetPostsFeed({ before = null, limit = 20, username = null, artistId = null, artistVoiceOnly = false } = {}) {
  let q = supabase.from('posts')
    .select('*, profiles:author!inner(username, display_name, avatar_url), artists:artist_id(id, name, slug, avatar_url, is_verified)')
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 50));
  if (username) q = q.eq('author', username);
  if (artistId) {
    q = q.eq('artist_id', artistId);
    // artist_id means two different things depending on post_type: "this
    // artist is speaking" (release_announcement/artist_update) vs "this
    // artist is the subject of someone else's Artist Share post". The
    // artist's own page/dashboard "posts by this artist" list wants only
    // the former — otherwise a stranger's Artist Share recommending this
    // artist would show up looking like the artist posted it themselves.
    if (artistVoiceOnly) q = q.in('post_type', ['release_announcement', 'artist_update']);
  }
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) { console.error('[db] getPostsFeed:', error.message); return []; }
  return data || [];
}

// Artist-only post types (release_announcement, artist_update) are
// presented as coming from the artist page, not the underlying account —
// a fan following "DJ Nova" the artist shouldn't see the post attributed
// to whatever username claimed that page. Every other post type (including
// a regular post that merely references an artist via artist Share) still
// shows the human author, since artist_id there is "the recommendation" not
// "the speaker".
const ARTIST_VOICE_POST_TYPES = ['release_announcement', 'artist_update'];
function formatPost(p, myUsername = null) {
  const postingAsArtist = ARTIST_VOICE_POST_TYPES.includes(p.post_type) && p.artists;
  return {
    id: p.id,
    author: p.author,
    displayName: postingAsArtist ? p.artists.name : (p.profiles?.display_name || p.author),
    avatarUrl: postingAsArtist ? p.artists.avatar_url : (p.profiles?.avatar_url || null),
    postedAsArtist: !!postingAsArtist,
    artistSlug: p.artists?.slug || null,
    artistIsVerified: p.artists?.is_verified || false,
    postType: p.post_type,
    body: p.body,
    playlistId: p.playlist_id,
    trackId: p.track_id,
    artistId: p.artist_id,
    releaseId: p.release_id,
    likeCount: p.like_count || 0,
    commentCount: p.comment_count || 0,
    shareCount: p.share_count || 0,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    isOwner: myUsername ? p.author === myUsername : false,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/posts', rateLimit, async (req, res) => {
  const { token, postType, body, playlistId, trackId, artistId, releaseId } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!body && !playlistId && !trackId && !artistId && !releaseId) {
    return res.status(400).json({ error: 'Post must have body text or reference content.' });
  }
  if (body && body.length > 1000) return res.status(400).json({ error: 'Post body must be 1000 characters or fewer.' });

  // Every account can post. 'release_announcement' and 'artist_update' are
  // the two artist-only types — they require posting *as* a claimed artist
  // page, enforced below and mirrored by a DB CHECK (posts_artist_post_types_
  // require_artist_id) so this can't drift out of sync with the schema.
  const POST_TYPES = ['text', 'track', 'playlist', 'artist', 'release_announcement', 'artist_update'];
  const ARTIST_ONLY_TYPES = ['release_announcement', 'artist_update'];
  const resolvedType = postType || 'text';
  if (!POST_TYPES.includes(resolvedType)) {
    return res.status(400).json({ error: `Invalid post type. Must be one of: ${POST_TYPES.join(', ')}.` });
  }
  if (ARTIST_ONLY_TYPES.includes(resolvedType) && !artistId) {
    return res.status(400).json({ error: 'Release announcements and artist updates must be posted from an artist page.' });
  }
  if (resolvedType === 'release_announcement' && !releaseId) {
    return res.status(400).json({ error: 'A release announcement must reference a release.' });
  }

  try {
    // artistId on a post means "this post is from/about this artist page" —
    // when it's set, only the account that claimed that artist page may
    // post as it. Without this check, any signed-in account could tag an
    // arbitrary artistId on a post and have it show up as if that artist
    // posted it, which matters now that the Dashboard's Posts tab lets an
    // owner publish announcements this way.
    let postingArtist = null;
    if (artistId) {
      postingArtist = await dbGetArtistById(artistId);
      if (!postingArtist || postingArtist.account_id !== sess.username) {
        return res.status(403).json({ error: 'Only the artist who claimed this page can post as it.' });
      }
    }
    // releaseId on a release_announcement must belong to that same artist —
    // same "don't let the client tag arbitrary foreign-key ids" concern as
    // the artistId check above, just one level deeper.
    if (resolvedType === 'release_announcement') {
      const { data: rel } = await supabase
        .from('artist_releases').select('id').eq('id', releaseId).eq('artist_id', artistId).maybeSingle();
      if (!rel) return res.status(403).json({ error: 'That release does not belong to this artist.' });
    }
    // A shared playlist must be public, or owned by the person sharing it —
    // otherwise any account could post an arbitrary playlists_v2 id and the
    // resulting post-ref-card would point at a private playlist that isn't
    // theirs to surface. (The viewer itself separately enforces access on
    // open, but the post shouldn't be creatable pointing at it at all.)
    if (playlistId) {
      const { data: pl } = await supabase
        .from('playlists_v2').select('owner, is_public').eq('id', playlistId).maybeSingle();
      if (!pl || (!pl.is_public && pl.owner !== sess.username)) {
        return res.status(403).json({ error: 'You can only share your own or public playlists.' });
      }
    }
    // A shared track must actually be a published FREQ track — unpublished
    // (draft) tracks have no public stream and shouldn't be shareable.
    if (trackId) {
      const { data: tr } = await supabase
        .from('tracks').select('id, is_published').eq('id', trackId).maybeSingle();
      if (!tr || !tr.is_published) {
        return res.status(403).json({ error: 'That track is not available to share.' });
      }
    }
    const post = await dbCreatePost(sess.username, { postType: resolvedType, body, playlistId, trackId, artistId, releaseId });
    // Write to activity feed
    const activityType = ARTIST_ONLY_TYPES.includes(resolvedType) ? resolvedType : 'user_post';
    dbWriteActivity(activityType, sess.username, null, {
      postId: post.id,
      preview: (body || '').slice(0, 80),
      artistId: artistId || null,
      artistName: postingArtist?.name || null,
      releaseId: releaseId || null,
    });
    return res.status(201).json({ post: formatPost(post, sess.username) });
  } catch (err) {
    console.error('[posts create]', err);
    return res.status(500).json({ error: 'Could not create post.' });
  }
});

app.get('/api/posts', async (req, res) => {
  const before = req.query.before || null;
  const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const token  = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess   = token ? await dbGetSession(token) : null;
  try {
    const posts = await dbGetPostsFeed({ before, limit });
    // Batch-fetch liked status
    let likedIds = new Set();
    if (sess && posts.length) {
      const ids = posts.map(p => p.id);
      const { data: likes } = await supabase.from('post_likes')
        .select('post_id').eq('username', sess.username).in('post_id', ids);
      likedIds = new Set((likes || []).map(l => l.post_id));
    }
    return res.json({
      posts: posts.map(p => ({ ...formatPost(p, sess?.username), likedByMe: likedIds.has(p.id) })),
      hasMore: posts.length === limit,
    });
  } catch (err) {
    console.error('[posts feed]', err);
    return res.status(500).json({ error: 'Could not load posts.' });
  }
});

app.get('/api/posts/user/:username', async (req, res) => {
  const username = (req.params.username || '').toLowerCase();
  const before   = req.query.before || null;
  const limit    = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const token    = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess     = token ? await dbGetSession(token) : null;
  try {
    const posts = await dbGetPostsFeed({ before, limit, username });
    let likedIds = new Set();
    if (sess && posts.length) {
      const ids = posts.map(p => p.id);
      const { data: likes } = await supabase.from('post_likes')
        .select('post_id').eq('username', sess.username).in('post_id', ids);
      likedIds = new Set((likes || []).map(l => l.post_id));
    }
    return res.json({
      posts: posts.map(p => ({ ...formatPost(p, sess?.username), likedByMe: likedIds.has(p.id) })),
      hasMore: posts.length === limit,
    });
  } catch (err) {
    console.error('[posts user]', err);
    return res.status(500).json({ error: 'Could not load posts.' });
  }
});

app.get('/api/posts/artist/:id', async (req, res) => {
  const before = req.query.before || null;
  const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const token  = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess   = token ? await dbGetSession(token) : null;
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    const posts = await dbGetPostsFeed({ before, limit, artistId: artist.id, artistVoiceOnly: true });
    let likedIds = new Set();
    if (sess && posts.length) {
      const ids = posts.map(p => p.id);
      const { data: likes } = await supabase.from('post_likes')
        .select('post_id').eq('username', sess.username).in('post_id', ids);
      likedIds = new Set((likes || []).map(l => l.post_id));
    }
    return res.json({
      posts: posts.map(p => ({ ...formatPost(p, sess?.username), likedByMe: likedIds.has(p.id) })),
      hasMore: posts.length === limit,
    });
  } catch (err) {
    console.error('[posts artist]', err);
    return res.status(500).json({ error: 'Could not load artist posts.' });
  }
});
app.get('/api/posts/:id', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess  = token ? await dbGetSession(token) : null;
  try {
    const post = await dbGetPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    let likedByMe = false;
    if (sess) {
      const { data } = await supabase.from('post_likes')
        .select('post_id').eq('post_id', post.id).eq('username', sess.username).maybeSingle();
      likedByMe = !!data;
    }
    return res.json({ post: { ...formatPost(post, sess?.username), likedByMe } });
  } catch (err) {
    return res.status(500).json({ error: 'Could not load post.' });
  }
});

app.patch('/api/posts/:id', rateLimit, async (req, res) => {
  const { token, body } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!body || typeof body !== 'string') return res.status(400).json({ error: '"body" is required.' });
  if (body.length > 1000) return res.status(400).json({ error: 'Post body must be 1000 characters or fewer.' });
  try {
    const post = await dbGetPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    if (post.author !== sess.username) return res.status(403).json({ error: 'Not your post.' });
    const { data, error } = await supabase.from('posts')
      .update({ body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    return res.json({ post: formatPost(data, sess.username) });
  } catch (err) {
    return res.status(500).json({ error: 'Could not update post.' });
  }
});

app.delete('/api/posts/:id', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const post = await dbGetPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    if (post.author !== sess.username) return res.status(403).json({ error: 'Not your post.' });
    await supabase.from('posts').delete().eq('id', req.params.id);
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: 'Could not delete post.' });
  }
});

app.post('/api/posts/:id/like', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const { error } = await supabase.from('post_likes')
      .upsert({ post_id: req.params.id, username: sess.username }, { onConflict: 'post_id,username' });
    if (error && error.code !== '23505') throw new Error(error.message);
    const { count } = await supabase.from('post_likes')
      .select('*', { count: 'exact', head: true }).eq('post_id', req.params.id);
    await supabase.from('posts').update({ like_count: count || 0 }).eq('id', req.params.id);
    return res.json({ liked: true, likeCount: count || 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Could not like post.' });
  }
});

app.delete('/api/posts/:id/like', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    await supabase.from('post_likes').delete().eq('post_id', req.params.id).eq('username', sess.username);
    const { count } = await supabase.from('post_likes')
      .select('*', { count: 'exact', head: true }).eq('post_id', req.params.id);
    await supabase.from('posts').update({ like_count: count || 0 }).eq('id', req.params.id);
    return res.json({ liked: false, likeCount: count || 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Could not unlike post.' });
  }
});
app.post('/api/posts/:id/share', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const post = await dbGetPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    const shareCount = (Number(post.share_count) || 0) + 1;
    const { error } = await supabase.from('posts').update({ share_count: shareCount }).eq('id', req.params.id);
    if (error) throw new Error(error.message);
    dbWriteActivity('post_shared', sess.username, post.author !== sess.username ? post.author : null, {
      postId: post.id,
      preview: (post.body || '').slice(0, 80),
    });
    return res.json({ shared: true, shareCount });
  } catch (err) {
    console.error('[posts share]', err);
    return res.status(500).json({ error: 'Could not share post.' });
  }
});

app.post('/api/posts/:id/comments', rateLimit, async (req, res) => {
  const { token, body } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!body || typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: '"body" is required.' });
  if (body.length > 500) return res.status(400).json({ error: 'Comment must be 500 characters or fewer.' });
  try {
    const { data, error } = await supabase.from('post_comments').insert({
      post_id: req.params.id, author: sess.username, body: body.trim(),
    }).select().single();
    if (error) throw new Error(error.message);
    const { count } = await supabase.from('post_comments')
      .select('*', { count: 'exact', head: true }).eq('post_id', req.params.id);
    await supabase.from('posts').update({ comment_count: count || 0 }).eq('id', req.params.id);
    return res.status(201).json({ comment: data });
  } catch (err) {
    return res.status(500).json({ error: 'Could not add comment.' });
  }
});

app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const { data, error } = await supabase.from('post_comments')
      .select('*, profiles:author!inner(username, display_name, avatar_url)')
      .eq('post_id', req.params.id)
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);
    return res.json({ comments: (data || []).map(c => ({
      id: c.id, postId: c.post_id, author: c.author,
      displayName: c.profiles?.display_name || c.author,
      avatarUrl: c.profiles?.avatar_url || null,
      body: c.body, createdAt: c.created_at,
    })) });
  } catch (err) {
    return res.status(500).json({ error: 'Could not load comments.' });
  }
});

app.delete('/api/posts/:id/comments/:cid', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const { data: comment } = await supabase.from('post_comments')
      .select('author, post_id').eq('id', req.params.cid).maybeSingle();
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    if (comment.author !== sess.username) return res.status(403).json({ error: 'Not your comment.' });
    await supabase.from('post_comments').delete().eq('id', req.params.cid);
    const { count } = await supabase.from('post_comments')
      .select('*', { count: 'exact', head: true }).eq('post_id', req.params.id);
    await supabase.from('posts').update({ comment_count: count || 0 }).eq('id', req.params.id);
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: 'Could not delete comment.' });
  }
});

// Also expose artist follower count recompute as admin util (GET returns current counts)
app.post('/api/admin/recount-artist-followers', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Not authorized.' });
  try {
    const { data: artists } = await supabase.from('artists').select('id');
    let updated = 0;
    for (const a of (artists || [])) {
      const { count } = await supabase.from('artist_followers')
        .select('*', { count: 'exact', head: true }).eq('artist_id', a.id);
      await supabase.from('artists').update({ follower_count: count || 0 }).eq('id', a.id);
      updated++;
    }
    return res.json({ recount: true, artistsUpdated: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Recount failed.' });
  }
});

// ─── END SOCIAL POSTS ────────────────────────────────────────────────────────

app.get('/api/artists', async (req, res) => {
  const sort   = ['trending', 'recent', 'followers'].includes(req.query.sort) ? req.query.sort : 'followers';
  const limit  = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const search = (req.query.search || '').trim().slice(0, 100) || null;
  try {
    const artists = await dbListArtists({ sort, limit, offset, search });
    return res.json({
      artists: artists.map(a => ({
        id: a.id, slug: a.slug, name: a.name, avatarUrl: a.avatar_url, bannerUrl: a.banner_url,
        isVerified: a.is_verified, isClaimed: !!a.account_id, followerCount: a.follower_count,
      })),
    });
  } catch (err) {
    console.error('[artists list]', err);
    return res.status(500).json({ error: 'Could not load artists.' });
  }
});

app.get('/api/artists/:id', async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });

    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    const sess  = token ? await dbGetSession(token) : null;
    const [cachedStats, isFollowing] = await Promise.all([
      dbGetArtistStats(artist.id),
      sess ? dbIsFollowingArtist(sess.username, artist.id) : Promise.resolve(false),
    ]);
    const stats = await dbGetLiveArtistStats(artist.id, cachedStats);

    return res.json({
      id: artist.id,
      slug: artist.slug,
      name: artist.name,
      avatarUrl: artist.avatar_url,
      bannerUrl: artist.banner_url,
      bio: artist.bio,
      genre: artist.genre,
      links: artist.links || {},
      isVerified: artist.is_verified,
      isClaimed: !!artist.account_id,
      isOwner: !!(sess && artist.account_id === sess.username),
      followerCount: stats.followerCount,
      isFollowing,
      joinedAt: artist.created_at,
      stats: {
        totalPlays: stats.totalPlays,
        totalPlays7d: stats.totalPlays7d,
        totalLikesReceived: stats.totalLikesReceived,
        monthlyListeners: stats.monthlyListeners,
        chartRank: stats.chartRank,
        chartRankPrev: stats.chartRankPrev,
        chartMovement: (stats.chartRank != null && stats.chartRankPrev != null)
          ? stats.chartRankPrev - stats.chartRank
          : null,
      },
    });
  } catch (err) {
    console.error('[artist get]', err);
    return res.status(500).json({ error: 'Could not load artist.' });
  }
});

app.get('/api/artists/:id/tracks', async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    const sort  = req.query.sort === 'trending' ? 'trending' : 'plays';
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const tracks = await dbGetArtistTracks(artist.id, { sort, limit });
    const collabsByTrack = await dbGetCollaboratorsForTracks(tracks.map(t => t.id));
    return res.json({
      tracks: tracks.map(t => ({
        id: t.id, originalUrl: t.original_url, platform: t.platform,
        title: t.title || t.original_url,
        playCount: t.play_count, playCount7d: t.play_count_7d,
        likeCount: t.like_count || 0,
        lastPlayedAt: t.last_played_at,
        coverUrl: t.cover_url || null,
        cloudFileId: t.cloud_file_id || null,
        publishedAt: t.published_at || null,
        isUpload: !!t.cloud_file_id,
        isExplicit: !!t.is_explicit,
        collaborators: (collabsByTrack.get(t.id) || []).map(shapeCollaborator),
      })),
    });
  } catch (err) {
    console.error('[artist tracks]', err);
    return res.status(500).json({ error: 'Could not load artist tracks.' });
  }
});

app.get('/api/artists/:id/releases', async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    // Owner can see private/unlisted releases; visitors only see public.
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    let isOwner = false;
    if (token) {
      const sess = await dbGetSession(token);
      isOwner = !!(sess && artist.account_id === sess.username);
    }
    const type = ['single', 'album', 'ep', 'mixtape', 'compilation'].includes(req.query.type) ? req.query.type : null;
    const releases = await dbGetArtistReleases(artist.id, { type, includeNonPublic: isOwner });
    const releasesWithCollabs = await Promise.all(releases.map(async r => ({
      r, collaborators: (await dbGetReleaseCollaborators(r.id)).map(shapeCollaborator),
    })));
    return res.json({
      releases: await Promise.all(releasesWithCollabs.map(async ({ r, collaborators }) => {
        // Live explicit check: any track in this release explicit?
        const { data: explicitCheck } = await supabase
          .from('artist_release_tracks')
          .select('tracks!inner(is_explicit)')
          .eq('release_id', r.id)
          .eq('tracks.is_explicit', true)
          .limit(1);
        return {
          id: r.id, title: r.title, releaseType: r.release_type, coverUrl: r.cover_url,
          releaseDate: r.release_date, trackCount: r.track_count, totalPlays: r.total_plays,
          totalLikes: r.total_likes, description: r.description, externalUrl: r.external_url,
          visibility: r.visibility || 'public',
          isExplicit: !!(explicitCheck && explicitCheck.length > 0),
          collaborators,
        };
      })),
    });
  } catch (err) {
    console.error('[artist releases]', err);
    return res.status(500).json({ error: 'Could not load releases.' });
  }
});

app.get('/api/artists/:id/releases/:releaseId/tracks', async (req, res) => {
  try {
    // Visibility gate: private releases require ownership
    const { data: release, error: relErr } = await supabase
      .from('artist_releases')
      .select('id, visibility, artist_id')
      .eq('id', req.params.releaseId)
      .maybeSingle();
    if (relErr || !release) return res.status(404).json({ error: 'Release not found.' });

    if (release.visibility === 'private') {
      const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
      const sess = token ? await dbGetSession(token) : null;
      const artist = sess ? await dbGetArtistById(release.artist_id) : null;
      if (!artist || artist.account_id !== sess?.username) {
        return res.status(403).json({ error: 'This release is private.' });
      }
    }

    const tracks = await dbGetReleaseTracks(req.params.releaseId);
    const collabsByTrack = await dbGetCollaboratorsForTracks(tracks.map(t => t.id));
    return res.json({
      tracks: tracks.map(t => ({
        id: t.id, originalUrl: t.original_url, platform: t.platform,
        title: t.title || t.original_url, playCount: t.play_count, position: t.position,
        coverUrl: t.cover_url || null,
        cloudFileId: t.cloud_file_id || null,
        artistId: t.artist_id || null,
        artistName: t.artist_name || null,
        isUpload: !!t.cloud_file_id,
        isExplicit: !!t.is_explicit,
        collaborators: (collabsByTrack.get(t.id) || []).map(shapeCollaborator),
      })),
    });
  } catch (err) {
    console.error('[release tracks]', err);
    return res.status(500).json({ error: 'Could not load release tracks.' });
  }
});

// Artist's own activity (new releases, milestone follows, etc) PLUS recent
// community activity that references this artist (a track of theirs got
// liked, added to a playlist) — both already land in activity_feed with
// meta.artistId set, either via dbWriteArtistActivity (artist-originated)
// or via existing event types extended with artistId in their payload.
// Filtering activity_feed by meta->>artistId here, mirroring the same
// PostgREST or-clause shape dbGetFollowingFeed already uses for the
// artist-follow case.
app.get('/api/artists/:id/activity', async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const before = req.query.before || null;

    let q = supabase.from('activity_feed').select('*')
      .eq('meta->>artistId', artist.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) { console.error('[artist activity]', error.message); return res.json({ events: [] }); }

    return res.json({
      events: (data || []).map(e => ({
        id: e.id, type: e.event_type, actor: e.actor.startsWith('artist:') ? null : e.actor,
        payload: e.meta, createdAt: e.created_at,
      })),
      nextCursor: (data || []).length === limit ? data[data.length - 1].created_at : null,
    });
  } catch (err) {
    console.error('[artist activity]', err);
    return res.status(500).json({ error: 'Could not load artist activity.' });
  }
});

app.post('/api/artists/:id/follow', artistFollowRateLimit, async (req, res) => {
  const sess = req._followSession;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id === sess.username) {
      return res.status(400).json({ error: "You can't follow your own artist page." });
    }
    await dbFollowArtist(sess.username, artist.id);
    dbWriteArtistActivity('artist_followed', artist.id, { follower: sess.username, artistName: artist.name });
    const updated = await dbGetArtistById(artist.id);
    return res.json({ following: true, followerCount: updated ? updated.follower_count : artist.follower_count + 1 });
  } catch (err) {
    console.error('[artist follow]', err);
    return res.status(500).json({ error: 'Could not follow artist.' });
  }
});

app.delete('/api/artists/:id/follow', artistFollowRateLimit, async (req, res) => {
  const sess = req._followSession;
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    await dbUnfollowArtist(sess.username, artist.id);
    const updated = await dbGetArtistById(artist.id);
    return res.json({ following: false, followerCount: updated ? updated.follower_count : Math.max(artist.follower_count - 1, 0) });
  } catch (err) {
    console.error('[artist unfollow]', err);
    return res.status(500).json({ error: 'Could not unfollow artist.' });
  }
});

// Creates a brand-new artist page for the signed-in account — this is the
// actual "Become an Artist" entry point. /api/artists/claim (below) only
// works if an unclaimed artist row ALREADY exists (e.g. auto-created by
// dbResolveArtist from a prior anonymous play of that name); a user with
// no plays under their name yet has nothing to claim, which is exactly
// the gap this route fills.
//
// If an unclaimed row already exists under the normalized name (their
// music got played before they signed up), this CLAIMS that row instead
// of creating a duplicate — same merge principle dbResolveArtist already
// uses for play-time dedup, just triggered from account creation instead.
// `merged: true` in the response lets the frontend say "we found your
// existing stats" rather than silently inheriting a stranger's-looking row.
app.post('/api/artists/create', rateLimit, async (req, res) => {
  const { token, name } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });

  const existing = await dbGetArtistByAccount(sess.username);
  if (existing) return res.status(409).json({ error: 'Your account has already claimed an artist page.' });

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '"name" is required.' });
  }
  const trimmedName = name.trim().slice(0, 100);
  const normalized = normalizeArtistName(trimmedName);
  if (!normalized) return res.status(400).json({ error: 'Please enter a valid artist name.' });

  try {
    const { data: existingUnclaimed } = await supabase
      .from('artists').select('id, account_id').eq('normalized_name', normalized).maybeSingle();

    if (existingUnclaimed) {
      if (existingUnclaimed.account_id) {
        return res.status(409).json({ error: 'An artist with this name already exists and is already claimed.' });
      }
      const updated = await dbUpdateArtist(existingUnclaimed.id, {
        account_id: sess.username, claimed_at: new Date().toISOString(),
      });
      return res.status(200).json({
        id: updated.id, slug: updated.slug, name: updated.name, isClaimed: true, merged: true,
      });
    }

    const slug = await dbGenerateUniqueArtistSlug(trimmedName);
    const { data: created, error } = await supabase
      .from('artists')
      .insert({
        name: trimmedName, normalized_name: normalized, slug,
        account_id: sess.username, claimed_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (error) {
      // Lost a race to a concurrent create/claim of the same normalized
      // name — same shape as dbResolveArtist's own 23505 handling.
      if (error.code === '23505') return res.status(409).json({ error: 'That artist name was just taken. Please try a different name.' });
      throw new Error(error.message);
    }
    return res.status(201).json({
      id: created.id, slug: created.slug, name: created.name, isClaimed: true, merged: false,
    });
  } catch (err) {
    console.error('[artist create]', err);
    return res.status(500).json({ error: 'Could not create artist page.' });
  }
});


// Claims an existing unclaimed artist row for the signed-in account — the
// "verified artist applications" flow this enables later is just: an admin
// flips is_verified after a claim, not a separate table. One account can
// claim at most one artist (artists.account_id has a UNIQUE constraint),
// and an artist can only ever be claimed once (the WHERE account_id IS
// NULL check below, backed by the same partial-unique-index reasoning as
// get_or_create_artist's dedup).
app.post('/api/artists/claim', rateLimit, async (req, res) => {
  const { token, artistId } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!artistId || typeof artistId !== 'string') return res.status(400).json({ error: '"artistId" is required.' });
  try {
    const existing = await dbGetArtistByAccount(sess.username);
    if (existing) return res.status(409).json({ error: 'Your account has already claimed an artist page.' });

    const artist = await dbGetArtistById(artistId);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id) return res.status(409).json({ error: 'This artist page has already been claimed.' });

    const updated = await dbUpdateArtist(artist.id, { account_id: sess.username, claimed_at: new Date().toISOString() });
    return res.json({
      id: updated.id, name: updated.name, isClaimed: true, claimedAt: updated.claimed_at,
    });
  } catch (err) {
    console.error('[artist claim]', err);
    return res.status(500).json({ error: 'Could not claim this artist page.' });
  }
});

// Link keys an artist's Settings pane can set. Kept as a fixed allowlist
// rather than accepting arbitrary keys — links is rendered directly back
// out on the public artist page eventually, so this also bounds what ever
// needs escaping/handling there to a known, small set of platforms.
const ARTIST_LINK_KEYS = ['website', 'spotify', 'soundcloud', 'instagram', 'twitter', 'youtube'];

app.patch('/api/artists/:id', rateLimit, async (req, res) => {
  const { token, bio, avatarUrl, bannerUrl, genre, links } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can edit it.' });
    }
    const patch = {};
    if (bio !== undefined) {
      if (typeof bio !== 'string') return res.status(400).json({ error: '"bio" must be a string.' });
      const trimmed = bio.trim();
      if (trimmed.length > 2000) return res.status(400).json({ error: 'Bio must be 2000 characters or fewer.' });
      patch.bio = trimmed || null;
    }
    if (avatarUrl !== undefined) patch.avatar_url = (typeof avatarUrl === 'string' && avatarUrl.trim()) ? avatarUrl.trim().slice(0, 2000) : null;
    if (bannerUrl !== undefined) patch.banner_url = (typeof bannerUrl === 'string' && bannerUrl.trim()) ? bannerUrl.trim().slice(0, 2000) : null;
    if (genre !== undefined) {
      if (genre !== null && typeof genre !== 'string') return res.status(400).json({ error: '"genre" must be a string.' });
      patch.genre = (genre || '').toString().trim().slice(0, 60) || null;
    }
    if (links !== undefined) {
      if (typeof links !== 'object' || links === null || Array.isArray(links)) {
        return res.status(400).json({ error: '"links" must be an object.' });
      }
      const cleanLinks = {};
      for (const key of ARTIST_LINK_KEYS) {
        const val = links[key];
        if (typeof val === 'string' && val.trim()) cleanLinks[key] = val.trim().slice(0, 500);
      }
      patch.links = cleanLinks;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields to update.' });

    const updated = await dbUpdateArtist(artist.id, patch);
    return res.json({
      id: updated.id, bio: updated.bio, avatarUrl: updated.avatar_url, bannerUrl: updated.banner_url,
      genre: updated.genre, links: updated.links || {},
    });
  } catch (err) {
    console.error('[artist update]', err);
    return res.status(500).json({ error: 'Could not update artist page.' });
  }
});

// Artist avatar/banner upload — multipart, same uploadMediaImage() helper
// as the profile avatar/cover routes, namespaced under artist-avatars/ and
// artist-banners/ in the shared `media` bucket. Ownership check mirrors
// PATCH /api/artists/:id exactly: only the account that claimed this artist
// page can upload art for it.
app.post('/api/artists/:id/avatar', rateLimit, imageUpload.single('file'), async (req, res) => {
  const sess = await dbGetSession(req.body?.token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can upload art for it.' });
    }
    const avatarUrl = await uploadMediaImage(req.file, 'artist-avatars', artist.id);
    await dbUpdateArtist(artist.id, { avatar_url: avatarUrl });
    return res.json({ avatarUrl });
  } catch (err) {
    console.error('[artist avatar upload]', err);
    return res.status(500).json({ error: 'Could not upload artist avatar.' });
  }
});

app.post('/api/artists/:id/banner', rateLimit, imageUpload.single('file'), async (req, res) => {
  const sess = await dbGetSession(req.body?.token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can upload art for it.' });
    }
    const bannerUrl = await uploadMediaImage(req.file, 'artist-banners', artist.id);
    await dbUpdateArtist(artist.id, { banner_url: bannerUrl });
    return res.json({ bannerUrl });
  } catch (err) {
    console.error('[artist banner upload]', err);
    return res.status(500).json({ error: 'Could not upload artist banner.' });
  }
});

app.post('/api/artists/:id/releases', rateLimit, async (req, res) => {
  const { token, title, releaseType, coverUrl, releaseDate, trackIds, visibility } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can publish releases.' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: '"title" is required.' });
    }
    if (!['single', 'album', 'ep', 'mixtape', 'compilation'].includes(releaseType)) {
      return res.status(400).json({ error: '"releaseType" must be one of single, album, ep, mixtape, compilation.' });
    }
    const release = await dbCreateRelease(artist.id, {
      title: title.trim().slice(0, 200), releaseType,
      coverUrl: coverUrl || null, releaseDate: releaseDate || null,
      visibility: visibility || 'public',
    });
    if (Array.isArray(trackIds) && trackIds.length) {
      for (const trackId of trackIds.slice(0, 100)) {
        try { await dbAddTrackToRelease(release.id, trackId); } catch (e) { console.error('[release add track]', e.message); }
      }
    }
    dbWriteArtistActivity('artist_release', artist.id, {
      releaseId: release.id, releaseTitle: release.title, releaseType: release.release_type, artistName: artist.name,
    });
    return res.status(201).json({
      id: release.id, title: release.title, releaseType: release.release_type,
      coverUrl: release.cover_url, releaseDate: release.release_date, trackCount: release.track_count,
      visibility: release.visibility || 'public',
    });
  } catch (err) {
    console.error('[artist create release]', err);
    return res.status(500).json({ error: 'Could not create release.' });
  }
});

// DELETE /api/artists/:id/releases/:releaseId  { token }  (owner only)
// Removes the release row only — its tracks aren't deleted, just unlinked
// from this release (see dbDeleteRelease comment). Same 401/403 ownership
// pattern as every other artist-mutation route in this file: missing/bad
// session is 401, a real session that isn't this artist's owner is 403.
app.delete('/api/artists/:id/releases/:releaseId', rateLimit, async (req, res) => {
  const token = req.body?.token || req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can delete releases.' });
    }
    const { data: release } = await supabase
      .from('artist_releases').select('id').eq('id', req.params.releaseId).eq('artist_id', artist.id).maybeSingle();
    if (!release) return res.status(404).json({ error: 'Release not found.' });

    await dbDeleteRelease(release.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[artist delete release]', err);
    return res.status(500).json({ error: 'Could not delete release.' });
  }
});

// PATCH /api/artists/:id/releases/:releaseId  { token, title?, coverUrl?, releaseDate?, description?, visibility? }
// Edit release metadata. release_type is immutable after creation by design.
app.patch('/api/artists/:id/releases/:releaseId', rateLimit, async (req, res) => {
  const { token, title, coverUrl, releaseDate, description, visibility } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can edit releases.' });
    }
    const { data: release } = await supabase
      .from('artist_releases').select('id').eq('id', req.params.releaseId).eq('artist_id', artist.id).maybeSingle();
    if (!release) return res.status(404).json({ error: 'Release not found.' });

    const patch = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: '"title" must be a non-empty string.' });
      patch.title = title.trim().slice(0, 200);
    }
    if (coverUrl !== undefined) {
      patch.cover_url = (typeof coverUrl === 'string' && coverUrl.trim()) ? coverUrl.trim().slice(0, 2000) : null;
    }
    if (releaseDate !== undefined) {
      patch.release_date = releaseDate || null;
    }
    if (description !== undefined) {
      patch.description = (typeof description === 'string') ? description.trim().slice(0, 2000) || null : null;
    }
    if (visibility !== undefined) {
      patch.visibility = ['public', 'private', 'unlisted'].includes(visibility) ? visibility : 'public';
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields to update.' });
    const updated = await dbUpdateRelease(release.id, patch);
    return res.json({
      id: updated.id, title: updated.title, releaseType: updated.release_type,
      coverUrl: updated.cover_url, releaseDate: updated.release_date,
      description: updated.description, trackCount: updated.track_count,
      visibility: updated.visibility || 'public',
    });
  } catch (err) {
    console.error('[artist update release]', err);
    return res.status(500).json({ error: 'Could not update release.' });
  }
});

// DELETE /api/artists/:id/releases/:releaseId/tracks/:trackId  { token }
// Remove a single track from a release (unlinks it, does not delete the track).
app.delete('/api/artists/:id/releases/:releaseId/tracks/:trackId', rateLimit, async (req, res) => {
  const token = req.body?.token || req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can manage releases.' });
    }
    const { data: release } = await supabase
      .from('artist_releases').select('id').eq('id', req.params.releaseId).eq('artist_id', artist.id).maybeSingle();
    if (!release) return res.status(404).json({ error: 'Release not found.' });
    await dbRemoveTrackFromRelease(release.id, req.params.trackId);
    return res.json({ success: true });
  } catch (err) {
    console.error('[release remove track]', err);
    return res.status(500).json({ error: 'Could not remove track from release.' });
  }
});

// POST /api/artists/:id/releases/:releaseId/tracks  { token, trackId }
// Add an existing published track to a release (e.g. after editing release assignment).
app.post('/api/artists/:id/releases/:releaseId/tracks', rateLimit, async (req, res) => {
  const { token, trackId } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!trackId) return res.status(400).json({ error: '"trackId" is required.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can manage releases.' });
    }
    const { data: release } = await supabase
      .from('artist_releases').select('id').eq('id', req.params.releaseId).eq('artist_id', artist.id).maybeSingle();
    if (!release) return res.status(404).json({ error: 'Release not found.' });
    const track = await dbGetTrackById(trackId);
    if (!track || track.artist_id !== artist.id) return res.status(404).json({ error: 'Track not found or does not belong to this artist.' });
    await dbAddTrackToRelease(release.id, track.id);
    return res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('duplicate')) return res.status(409).json({ error: 'Track is already in this release.' });
    console.error('[release add track]', err);
    return res.status(500).json({ error: 'Could not add track to release.' });
  }
});
// Same ownership shape as DELETE /releases/:releaseId just above: resolve
// the artist from the URL, confirm they're the session's account, then
// confirm the release actually belongs to that artist before touching it.
// Listing is public (GET has no auth requirement) — release collaborator
// credits are meant to be visible on the public release/artist page.
app.get('/api/artists/:id/releases/:releaseId/collaborators', rateLimit, async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    const { data: release } = await supabase
      .from('artist_releases').select('id').eq('id', req.params.releaseId).eq('artist_id', artist.id).maybeSingle();
    if (!release) return res.status(404).json({ error: 'Release not found.' });
    const collaborators = (await dbGetReleaseCollaborators(release.id)).map(shapeCollaborator);
    return res.json({ collaborators });
  } catch (err) {
    console.error('[release collaborators list]', err);
    return res.status(500).json({ error: 'Could not load collaborators.' });
  }
});

app.post('/api/artists/:id/releases/:releaseId/collaborators', rateLimit, async (req, res) => {
  const { token, artistId, role } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (typeof artistId !== 'string' || !artistId.trim()) return res.status(400).json({ error: '"artistId" is required.' });
  if (!COLLAB_ROLES.includes(role)) return res.status(400).json({ error: `"role" must be one of: ${COLLAB_ROLES.join(', ')}.` });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can manage release collaborators.' });
    }
    const { data: release } = await supabase
      .from('artist_releases').select('id, artist_id').eq('id', req.params.releaseId).eq('artist_id', artist.id).maybeSingle();
    if (!release) return res.status(404).json({ error: 'Release not found.' });
    if (artistId === release.artist_id) {
      return res.status(400).json({ error: 'This artist is already the primary artist on this release.' });
    }
    const collaboratorArtist = await dbGetArtistById(artistId);
    if (!collaboratorArtist) return res.status(404).json({ error: 'Collaborator artist not found.' });
    const row = await dbAddCollaborator({
      releaseId: release.id, collaboratorArtistId: artistId, role, addedByUsername: sess.username,
    });
    return res.json({ collaborator: shapeCollaborator(row) });
  } catch (err) {
    console.error('[release collaborator add]', err);
    return res.status(err.message?.includes('already has this role') ? 409 : 500)
      .json({ error: err.message || 'Could not add collaborator.' });
  }
});

app.delete('/api/artists/:id/releases/:releaseId/collaborators/:collabId', rateLimit, async (req, res) => {
  const token = req.body?.token || req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can manage release collaborators.' });
    }
    const { data: release } = await supabase
      .from('artist_releases').select('id').eq('id', req.params.releaseId).eq('artist_id', artist.id).maybeSingle();
    if (!release) return res.status(404).json({ error: 'Release not found.' });
    const collab = await dbGetCollaboration(req.params.collabId);
    if (!collab || collab.release_id !== release.id) return res.status(404).json({ error: 'Collaborator credit not found.' });
    await dbRemoveCollaboration(collab.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[release collaborator remove]', err);
    return res.status(500).json({ error: 'Could not remove collaborator.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLISHING — turning a private cloud_files upload into a public track
//
//  GET    /api/artists/:id/publishable          ?token=   → owner's unpublished uploads
//  POST   /api/artists/:id/publish               { token, cloudFileId, title, coverUrl, releaseId }
//  PATCH  /api/tracks/:trackId                   { token, title, coverUrl }
//  DELETE /api/tracks/:trackId                   { token }
//
//  Publishing does NOT create a second track system — it creates exactly
//  one new `tracks` row per cloud_files row, linked via tracks.cloud_file_id
//  (see add_publishing_to_tracks migration). Every existing consumer of
//  `tracks` — charts, artist tracks, releases, plays — works on a published
//  upload with zero changes, since it's the same table `tracks` always was
//  for YouTube-resolved tracks (the only kind FREQ had until now). A
//  partial unique index on cloud_file_id (see migration) guarantees at
//  most one published track per cloud_files row, so re-publishing the same
//  file is rejected, not silently duplicated.
// ═══════════════════════════════════════════════════════════════════════════════

// Cloud files this artist owns that haven't been published yet — i.e. not
// already linked to a tracks row. LEFT JOIN-via-NOT-IN rather than a
// second round trip per file; cloud_files belonging to this account that
// have no matching tracks.cloud_file_id are exactly the publishable set.
async function dbGetPublishableCloudFiles(username) {
  const { data: files, error } = await supabase
    .from('cloud_files')
    .select('id, filename, title, artist, duration, mime_type, size, uploaded_at, folder')
    .eq('owner', username)
    .order('uploaded_at', { ascending: false });
  if (error) { console.error('[db] getPublishableCloudFiles:', error.message); return []; }
  if (!files || !files.length) return [];

  const { data: published, error: pubErr } = await supabase
    .from('tracks')
    .select('cloud_file_id')
    .not('cloud_file_id', 'is', null)
    .in('cloud_file_id', files.map(f => f.id));
  if (pubErr) { console.error('[db] getPublishableCloudFiles (published lookup):', pubErr.message); return []; }
  const publishedIds = new Set((published || []).map(p => p.cloud_file_id));

  return files.filter(f => !publishedIds.has(f.id));
}

// Publishes one cloud_files row as a tracks row. originalUrl is a synthetic
// `cloud:<cloud_file_id>` value — tracks.original_url is NOT NULL + UNIQUE
// and was designed around real external URLs (YouTube etc), so a published
// upload needs *some* unique value there; cloud_file_id already guarantees
// uniqueness, so reusing it as the URL avoids inventing a second identity
// scheme. platform is the literal string 'cloud' so the frontend/queue can
// tell a published upload apart from a YouTube-resolved track without
// needing to check cloud_file_id specifically.
async function dbPublishTrack({ cloudFile, artist, title, coverUrl, isExplicit = false }) {
  const finalTitle = (title && title.trim()) ? title.trim().slice(0, 255) : (cloudFile.title || cloudFile.filename);
  const { data, error } = await supabase
    .from('tracks')
    .insert({
      original_url: `cloud:${cloudFile.id}`,
      platform: 'cloud',
      title: finalTitle,
      artist_id: artist.id,
      artist_name: artist.name,
      cloud_file_id: cloudFile.id,
      cover_url: coverUrl || null,
      is_published: true,
      is_explicit: !!isExplicit,
      published_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') throw Object.assign(new Error('This file has already been published.'), { code: 'ALREADY_PUBLISHED' });
    throw new Error(error.message);
  }
  return data;
}

async function dbGetTrackById(trackId) {
  const { data, error } = await supabase.from('tracks').select('*').eq('id', trackId).maybeSingle();
  if (error) { console.error('[db] getTrackById:', error.message); return null; }
  return data;
}

async function dbUpdatePublishedTrack(trackId, patch) {
  const { data, error } = await supabase.from('tracks').update(patch).eq('id', trackId).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function dbUnpublishTrack(trackId) {
  // Hard-delete, not a soft "is_published = false" flip — an unpublished
  // upload's tracks row has no further purpose (it's not playable from
  // anywhere once removed from charts/discovery/releases), and leaving a
  // dead row around would just be a second place the same cloud_files
  // upload could accidentally get "republished" against. artist_release_tracks
  // rows referencing this track cascade-delete via their FK, so the release
  // it belonged to has its track removed cleanly, not left dangling.
  //
  // After delete we immediately kick recomputeArtistStats so the dashboard
  // play counts and release totals don't show stale numbers until the next
  // 10-minute timer fires.
  const { error } = await supabase.from('tracks').delete().eq('id', trackId);
  if (error) throw new Error(error.message);
  // Fire-and-forget recompute — don't await, deletion already succeeded
  recomputeArtistStats().catch(err => console.error('[unpublish] recompute failed:', err));
}

app.get('/api/artists/:id/publishable', rateLimit, async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can view publishable files.' });
    }
    const files = await dbGetPublishableCloudFiles(sess.username);
    return res.json({
      files: files.map(f => ({
        id: f.id, filename: f.filename, title: f.title, artist: f.artist,
        duration: f.duration, mimeType: f.mime_type, size: f.size,
        uploadedAt: f.uploaded_at, folder: f.folder,
      })),
    });
  } catch (err) {
    console.error('[artist publishable]', err);
    return res.status(500).json({ error: 'Could not load publishable files.' });
  }
});

// Cover-art upload for a single published track (not part of a release) —
// same uploadMediaImage() helper as every other image route, namespaced
// under track-covers/ in the shared media bucket. Takes a cloudFileId, not
// a trackId, because this is meant to be called *before* publish (pick the
// cover while setting up metadata) as well as after — the frontend can
// always re-PATCH a track's coverUrl later via PATCH /api/tracks/:trackId
// using the URL this returns.
app.post('/api/artists/:id/track-cover', rateLimit, imageUpload.single('file'), async (req, res) => {
  const sess = await dbGetSession(req.body?.token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  const cloudFileId = Number(req.body?.cloudFileId);
  if (!cloudFileId) return res.status(400).json({ error: '"cloudFileId" is required.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can upload cover art.' });
    }
    const owned = await dbGetCloudFile(cloudFileId, sess.username);
    if (!owned) return res.status(404).json({ error: 'File not found in your library.' });
    const coverUrl = await uploadMediaImage(req.file, 'track-covers', cloudFileId);
    return res.json({ coverUrl });
  } catch (err) {
    console.error('[track cover upload]', err);
    return res.status(500).json({ error: 'Could not upload cover art.' });
  }
});

app.post('/api/artists/:id/publish', rateLimit, async (req, res) => {
  const { token, cloudFileId, title, coverUrl, releaseId, isExplicit } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (!cloudFileId) return res.status(400).json({ error: '"cloudFileId" is required.' });
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    if (artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can publish releases.' });
    }
    const cloudFile = await dbGetCloudFile(Number(cloudFileId), sess.username);
    if (!cloudFile) return res.status(404).json({ error: 'File not found in your library.' });

    let release = null;
    if (releaseId) {
      const { data } = await supabase.from('artist_releases').select('*').eq('id', releaseId).eq('artist_id', artist.id).maybeSingle();
      if (!data) return res.status(404).json({ error: 'Release not found.' });
      release = data;
    }

    const track = await dbPublishTrack({
      cloudFile, artist, title,
      coverUrl: coverUrl || release?.cover_url || null,
      isExplicit: !!isExplicit,
    });

    if (release) {
      await dbAddTrackToRelease(release.id, track.id);
    }

    // Surfaces in Activity Feed (and, via dbGetFollowingFeed's artistId
    // clause, to anyone following this artist) and is the same event the
    // Discovery/Charts/Search "appears automatically" requirement leans
    // on — nothing else needs to separately notify those surfaces, since
    // they all read off either this feed entry or the tracks row directly.
    dbWriteArtistActivity('track_published', artist.id, {
      trackId: track.id, trackTitle: track.title, artistName: artist.name,
      releaseId: release ? release.id : null, releaseTitle: release ? release.title : null,
    });

    return res.status(201).json({
      id: track.id, title: track.title, coverUrl: track.cover_url,
      publishedAt: track.published_at, releaseId: release ? release.id : null,
    });
  } catch (err) {
    if (err.code === 'ALREADY_PUBLISHED') return res.status(409).json({ error: err.message });
    console.error('[artist publish]', err);
    return res.status(500).json({ error: 'Could not publish track.' });
  }
});

app.patch('/api/tracks/:trackId', rateLimit, async (req, res) => {
  const { token, title, coverUrl, description, releaseId } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track || !track.cloud_file_id) return res.status(404).json({ error: 'Published track not found.' });
    const artist = await dbGetArtistById(track.artist_id);
    if (!artist || artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who published this track can edit it.' });
    }
    const patch = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: '"title" must be a non-empty string.' });
      patch.title = title.trim().slice(0, 255);
    }
    if (coverUrl !== undefined) {
      patch.cover_url = (typeof coverUrl === 'string' && coverUrl.trim()) ? coverUrl.trim().slice(0, 2000) : null;
    }
    if (description !== undefined) {
      patch.description = (typeof description === 'string') ? description.trim().slice(0, 2000) || null : null;
    }

    // Release reassignment: remove from old release(s), add to new one if provided.
    // releaseId === null explicitly unlinks from all releases; omitting releaseId
    // entirely leaves release assignments untouched (standard PATCH semantics).
    if (releaseId !== undefined) {
      // Remove from any existing release(s) first
      const { data: existingLinks } = await supabase
        .from('artist_release_tracks')
        .select('release_id')
        .eq('track_id', track.id);
      for (const link of existingLinks || []) {
        await dbRemoveTrackFromRelease(link.release_id, track.id).catch(() => {});
      }
      // Attach to new release if a non-null releaseId was provided
      if (releaseId) {
        const { data: newRelease } = await supabase
          .from('artist_releases').select('id').eq('id', releaseId).eq('artist_id', artist.id).maybeSingle();
        if (!newRelease) return res.status(404).json({ error: 'Target release not found or does not belong to this artist.' });
        await dbAddTrackToRelease(newRelease.id, track.id);
      }
    }

    if (!Object.keys(patch).length && releaseId === undefined) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }
    let updated = track;
    if (Object.keys(patch).length) {
      updated = await dbUpdatePublishedTrack(track.id, patch);
    }
    return res.json({
      id: updated.id, title: updated.title, coverUrl: updated.cover_url,
      description: updated.description || null,
    });
  } catch (err) {
    console.error('[track update]', err);
    return res.status(500).json({ error: 'Could not update track.' });
  }
});

app.delete('/api/tracks/:trackId', rateLimit, async (req, res) => {
  const token = req.body?.token || req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track || !track.cloud_file_id) return res.status(404).json({ error: 'Published track not found.' });
    const artist = await dbGetArtistById(track.artist_id);
    if (!artist || artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who published this track can remove it.' });
    }
    await dbUnpublishTrack(track.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[track delete]', err);
    return res.status(500).json({ error: 'Could not remove track.' });
  }
});

// ── Track collaborators ─────────────────────────────────────────────────────
// Management (add/remove) is gated to the track's primary artist — the same
// "only the artist who published this track" check as PATCH/DELETE above —
// since crediting someone as a Featured Artist/Collaborator/Producer/
// Contributor on a track is an edit to that track, not something the
// credited artist grants themselves. Listing is public, same as the track
// itself being publicly streamable once published.
app.get('/api/tracks/:trackId/collaborators', rateLimit, async (req, res) => {
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track) return res.status(404).json({ error: 'Track not found.' });
    const collaborators = (await dbGetTrackCollaborators(track.id)).map(shapeCollaborator);
    return res.json({ collaborators });
  } catch (err) {
    console.error('[track collaborators list]', err);
    return res.status(500).json({ error: 'Could not load collaborators.' });
  }
});

app.post('/api/tracks/:trackId/collaborators', rateLimit, async (req, res) => {
  const { token, artistId, role } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  if (typeof artistId !== 'string' || !artistId.trim()) return res.status(400).json({ error: '"artistId" is required.' });
  if (!COLLAB_ROLES.includes(role)) return res.status(400).json({ error: `"role" must be one of: ${COLLAB_ROLES.join(', ')}.` });
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track || !track.cloud_file_id) return res.status(404).json({ error: 'Published track not found.' });
    const artist = await dbGetArtistById(track.artist_id);
    if (!artist || artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who published this track can manage its collaborators.' });
    }
    if (artistId === track.artist_id) {
      return res.status(400).json({ error: 'This artist is already the primary artist on this track.' });
    }
    const collaboratorArtist = await dbGetArtistById(artistId);
    if (!collaboratorArtist) return res.status(404).json({ error: 'Collaborator artist not found.' });
    const row = await dbAddCollaborator({
      trackId: track.id, collaboratorArtistId: artistId, role, addedByUsername: sess.username,
    });
    return res.json({ collaborator: shapeCollaborator(row) });
  } catch (err) {
    console.error('[track collaborator add]', err);
    return res.status(err.message?.includes('already has this role') ? 409 : 500)
      .json({ error: err.message || 'Could not add collaborator.' });
  }
});

app.delete('/api/tracks/:trackId/collaborators/:collabId', rateLimit, async (req, res) => {
  const token = req.body?.token || req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track) return res.status(404).json({ error: 'Track not found.' });
    const artist = await dbGetArtistById(track.artist_id);
    if (!artist || artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who published this track can manage its collaborators.' });
    }
    const collab = await dbGetCollaboration(req.params.collabId);
    if (!collab || collab.track_id !== track.id) return res.status(404).json({ error: 'Collaborator credit not found.' });
    await dbRemoveCollaboration(collab.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[track collaborator remove]', err);
    return res.status(500).json({ error: 'Could not remove collaborator.' });
  }
});

// GET /api/tracks/:trackId/lyrics  — public for published tracks
app.get('/api/tracks/:trackId/lyrics', async (req, res) => {
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track || !track.is_published) return res.status(404).json({ error: 'Track not found.' });
    const row = await dbGetTrackLyrics(track.id);
    return res.json({
      trackId: track.id,
      lyrics: row?.lyrics ?? null,
      synced: row?.synced ?? false,
      updatedAt: row?.updated_at ?? null,
    });
  } catch (err) {
    console.error('[track lyrics GET]', err);
    return res.status(500).json({ error: 'Could not load lyrics.' });
  }
});

// PUT /api/tracks/:trackId/lyrics  — owner only
app.put('/api/tracks/:trackId/lyrics', rateLimit, async (req, res) => {
  const { token, lyrics } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track) return res.status(404).json({ error: 'Track not found.' });
    const artist = await dbGetArtistById(track.artist_id);
    if (!artist || artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the track owner can edit lyrics.' });
    }
    if (typeof lyrics !== 'string') return res.status(400).json({ error: 'lyrics must be a string.' });
    const row = await dbUpsertTrackLyrics(track.id, lyrics.slice(0, 20000));
    return res.json({ trackId: track.id, lyrics: row.lyrics, updatedAt: row.updated_at });
  } catch (err) {
    console.error('[track lyrics PUT]', err);
    return res.status(500).json({ error: 'Could not save lyrics.' });
  }
});

// DELETE /api/tracks/:trackId/lyrics  — owner only
app.delete('/api/tracks/:trackId/lyrics', rateLimit, async (req, res) => {
  const token = req.body?.token || (req.headers.authorization || '').replace('Bearer ', '');
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track) return res.status(404).json({ error: 'Track not found.' });
    const artist = await dbGetArtistById(track.artist_id);
    if (!artist || artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the track owner can delete lyrics.' });
    }
    await dbDeleteTrackLyrics(track.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[track lyrics DELETE]', err);
    return res.status(500).json({ error: 'Could not delete lyrics.' });
  }
});

// GET /api/tracks/:trackId/stream  ?token=  (token optional — anyone can
// stream a published track, same "browsable by a visitor who hasn't signed
// in" philosophy as the artist routes above).
//
// Deliberately NOT the same code path as GET /api/cloud-files/:id — that
// route scopes its signed-url lookup to `.eq('owner', sess.username)`,
// correct for "manage my private uploads" but would 404 for every visitor
// trying to stream someone else's published music. The authorization
// boundary here is different on purpose: not "do you own this file" but
// "is this track actually published" — is_published=true is the only gate.
// An unpublished/draft upload can never reach this route's happy path even
// if someone guesses its trackId, because dbGetTrackById's row won't have
// is_published=true until the artist explicitly publishes it.
app.get('/api/tracks/:trackId/stream', rateLimit, async (req, res) => {
  try {
    const track = await dbGetTrackById(req.params.trackId);
    if (!track || !track.is_published || !track.cloud_file_id) {
      return res.status(404).json({ error: 'Track not found.' });
    }
    // Bypasses dbGetCloudFile's owner-scoped lookup on purpose — see comment
    // above. Goes straight to the table since the publish/ownership check
    // already happened once, permanently, at publish time.
    const { data: cloudFile, error: cfErr } = await supabase
      .from('cloud_files').select('storage_path, filename, mime_type, duration')
      .eq('id', track.cloud_file_id).maybeSingle();
    if (cfErr || !cloudFile) return res.status(404).json({ error: 'Track audio not found.' });

    const { data, error } = await supabase.storage
      .from(CLOUD_BUCKET)
      .createSignedUrl(cloudFile.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error) throw new Error(error.message);

    const collaborators = (await dbGetTrackCollaborators(track.id)).map(shapeCollaborator);

    return res.json({
      id: track.id, title: track.title, coverUrl: track.cover_url,
      artistId: track.artist_id, artistName: track.artist_name,
      mimeType: cloudFile.mime_type, duration: cloudFile.duration,
      url: data.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS,
      collaborators,
    });
  } catch (err) {
    console.error('[track stream]', err);
    return res.status(500).json({ error: 'Could not load track audio.' });
  }
});

// POST/DELETE /api/tracks/:trackId/like   { token }
// Mirrors /api/posts/:id/like exactly — upsert/delete on a join table, then
// recompute and persist the denormalized count. No per-track like existed
// anywhere in this schema before; track_likes + tracks.like_count were added
// specifically to back the Artist Dashboard Analytics view's Likes stat with
// a real number instead of the previous hardcoded `likeCount: 0` placeholder.
app.post('/api/tracks/:trackId/like', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    const { error } = await supabase.from('track_likes')
      .upsert({ track_id: req.params.trackId, username: sess.username }, { onConflict: 'track_id,username' });
    if (error && error.code !== '23505') throw new Error(error.message);
    const { count } = await supabase.from('track_likes')
      .select('*', { count: 'exact', head: true }).eq('track_id', req.params.trackId);
    await supabase.from('tracks').update({ like_count: count || 0 }).eq('id', req.params.trackId);
    return res.json({ liked: true, likeCount: count || 0 });
  } catch (err) {
    console.error('[track like]', err);
    return res.status(500).json({ error: 'Could not like track.' });
  }
});

app.delete('/api/tracks/:trackId/like', rateLimit, async (req, res) => {
  const { token } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  try {
    await supabase.from('track_likes').delete().eq('track_id', req.params.trackId).eq('username', sess.username);
    const { count } = await supabase.from('track_likes')
      .select('*', { count: 'exact', head: true }).eq('track_id', req.params.trackId);
    await supabase.from('tracks').update({ like_count: count || 0 }).eq('id', req.params.trackId);
    return res.json({ liked: false, likeCount: count || 0 });
  } catch (err) {
    console.error('[track unlike]', err);
    return res.status(500).json({ error: 'Could not unlike track.' });
  }
});

// GET /api/artists/:id/tracks/:trackId/analytics   ?token=
// Owner-only. Aggregates everything the Artist Dashboard's Analytics button
// needs in one call: play stats already on the tracks row, real like count,
// release association, publish date, and a small recent-activity slice from
// track_plays. Comments are intentionally NOT included — there is no
// comments-on-tracks feature anywhere in this schema (only posts have
// comments), so the analytics endpoint reports commentCount as null with a
// supported:false flag rather than fabricating a 0 that looks real but never
// updates. Surface that honestly in the UI instead of pretending it's wired up.
app.get('/api/artists/:id/tracks/:trackId/analytics', async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    const sess = token ? await dbGetSession(token) : null;
    if (!sess || artist.account_id !== sess.username) {
      return res.status(403).json({ error: 'Only the artist who claimed this page can view track analytics.' });
    }

    const { data: track, error: trackErr } = await supabase
      .from('tracks')
      .select('id, title, play_count, play_count_7d, like_count, published_at, cover_url, artist_id, cloud_file_id, is_explicit')
      .eq('id', req.params.trackId)
      .eq('artist_id', artist.id)
      .maybeSingle();
    if (trackErr) throw new Error(trackErr.message);
    if (!track) return res.status(404).json({ error: 'Track not found.' });

    // Release association — artist_release_tracks is the join table; a
    // track can appear in at most one release in this schema (no junction
    // beyond the single release_id/track_id pair per row).
    const { data: releaseLink } = await supabase
      .from('artist_release_tracks')
      .select('release_id, artist_releases(id, title, release_type)')
      .eq('track_id', track.id)
      .maybeSingle();

    // Recent activity — last 10 individual plays, newest first. This is the
    // existing track_plays log (already populated by dbLogPlay on every
    // play), just sliced and surfaced here for the first time.
    const { data: recentPlays } = await supabase
      .from('track_plays')
      .select('username, played_at')
      .eq('track_id', track.id)
      .order('played_at', { ascending: false })
      .limit(10);

    return res.json({
      id: track.id, title: track.title,
      coverUrl: track.cover_url, isExplicit: !!track.is_explicit,
      totalPlays: track.play_count || 0,
      totalPlays7d: track.play_count_7d || 0,
      likeCount: track.like_count || 0,
      commentCount: null, commentsSupported: false,
      publishedAt: track.published_at || null,
      release: releaseLink?.artist_releases
        ? { id: releaseLink.artist_releases.id, title: releaseLink.artist_releases.title, releaseType: releaseLink.artist_releases.release_type }
        : null,
      recentActivity: (recentPlays || []).map(p => ({
        username: p.username || 'Anonymous listener',
        playedAt: p.played_at,
      })),
    });
  } catch (err) {
    console.error('[track analytics]', err);
    return res.status(500).json({ error: 'Could not load track analytics.' });
  }
});

// These exist purely so pasting a profile/artist link into Discord/Twitter/
// iMessage shows that person's name and avatar instead of generic FREQ
// branding — the entire point of a "shareable" URL is how it looks when
// shared, not just that it resolves. Implementation is deliberately tiny:
// read index.html, string-replace three meta tags, send. No templating
// engine, no SSR framework — this is a few lines of value, not a system.
//
// BASE_URL prefers an explicit env var (set this on Render once a domain
// is attached) and falls back to localhost for local dev; og:url would be
// wrong without it, but the page still renders fine either way.
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DEFAULT_OG_IMAGE = `${BASE_URL}/Geometric%20Frequency%20Logo%20Emphasizing%20Modernity.ico`;

function escapeHtmlAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function injectOgTags({ title, description, image, url }) {
  let html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
  const t = escapeHtmlAttr(title);
  const d = escapeHtmlAttr(description);
  const i = escapeHtmlAttr(image || DEFAULT_OG_IMAGE);
  const u = escapeHtmlAttr(url);
  // Replace the existing <title> + description meta (always present, see
  // index.html's <head>) and append OG/Twitter card tags right after the
  // description tag — additive, doesn't disturb anything else in <head>.
  html = html.replace(/<title>.*?<\/title>/, `<title>${t}</title>`);
  html = html.replace(
    /<meta name="description"[^>]*>/,
    `<meta name="description" content="${d}" />\n` +
    `<meta property="og:title" content="${t}" />\n` +
    `<meta property="og:description" content="${d}" />\n` +
    `<meta property="og:image" content="${i}" />\n` +
    `<meta property="og:url" content="${u}" />\n` +
    `<meta property="og:type" content="profile" />\n` +
    `<meta name="twitter:card" content="summary" />\n` +
    `<meta name="twitter:title" content="${t}" />\n` +
    `<meta name="twitter:description" content="${d}" />\n` +
    `<meta name="twitter:image" content="${i}" />`
  );
  return html;
}

// Server-rendered entry point for shareable profile URLs. Falls through to
// the plain SPA shell (no OG tags) for a private or missing profile, same
// existence-probing protection GET /api/profiles/:username already has —
// a private profile's page source shouldn't visibly differ from a 404 in
// a way that confirms the username exists.
app.get('/u/:username', async (req, res) => {
  try {
    const profile = await dbGetProfile((req.params.username || '').trim().toLowerCase());
    if (profile && profile.is_public) {
      const html = await injectOgTags({
        title: `${profile.display_name || profile.username} (@${profile.username}) · FREQ`,
        description: profile.bio || `${profile.follower_count || 0} followers on FREQ`,
        image: profile.avatar_url,
        url: `${BASE_URL}/u/${profile.username}`,
      });
      return res.send(html);
    }
  } catch (err) {
    console.error('[og /u/:username]', err);
  }
  return res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/artist/:slug', async (req, res) => {
  try {
    const artist = await dbGetArtistBySlug((req.params.slug || '').trim().toLowerCase());
    if (artist) {
      const html = await injectOgTags({
        title: `${artist.name} · FREQ`,
        description: artist.bio || `${artist.follower_count || 0} followers on FREQ`,
        image: artist.avatar_url,
        url: `${BASE_URL}/artist/${artist.slug}`,
      });
      return res.send(html);
    }
  } catch (err) {
    console.error('[og /artist/:slug]', err);
  }
  return res.sendFile(path.join(__dirname, 'index.html'));
});


// ─── Reports ─────────────────────────────────────────────────────────────────

// Reason/targetType strings here MUST exactly match the `reports` table's
// CHECK constraints in Supabase — a mismatch passes server-side validation
// but throws a 23514 check-violation on insert. The DB calls the user-report
// type 'user' (not 'profile') and the harassment reason 'harassment' (not
// 'harassment_bullying'); the frontend label "Harassment / Bullying" maps to
// the single 'harassment' reason value.
const REPORT_REASONS = [
  'impersonation', 'copyright_violation', 'spam',
  'harassment', 'hate_speech', 'explicit_not_marked',
  'misleading_metadata', 'other',
];
const REPORT_TARGET_TYPES = ['track', 'release', 'artist', 'post', 'user'];

// POST /api/reports
app.post('/api/reports', rateLimit, async (req, res) => {
  const { token, targetType, targetId, reason, details } = req.body || {};
  const sess = await dbGetSession(token);
  if (!sess) return res.status(401).json({ error: 'Sign in to report content.' });
  if (!REPORT_TARGET_TYPES.includes(targetType)) return res.status(400).json({ error: 'Invalid targetType.' });
  if (!targetId) return res.status(400).json({ error: '"targetId" is required.' });
  if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason.' });

  let priority = 'normal';
  let targetUsername = null;
  if (targetType === 'user') targetUsername = targetId;
  else if (targetType === 'artist') {
    const { data: artistRow } = await supabase.from('artists').select('account_id').eq('id', targetId).maybeSingle();
    targetUsername = artistRow?.account_id || null;
  }
  if (targetUsername && targetUsername.toLowerCase() === 'slimey2017') priority = 'high';

  try {
    const { data, error } = await supabase.from('reports').insert({
      reporter_user_id: sess.username,
      target_type: targetType,
      target_id: String(targetId),
      reason,
      details: details ? String(details).slice(0, 2000) : null,
      priority,
    }).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'You have already reported this content.' });
      throw error;
    }
    return res.status(201).json({ id: data.id, status: data.status, isFounder: priority === 'high' });
  } catch (err) {
    console.error('[reports create]', err);
    return res.status(500).json({ error: 'Could not submit report.' });
  }
});

// GET /api/reports/check
app.get('/api/reports/check', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const sess = token ? await dbGetSession(token) : null;
  if (!sess) return res.json({ reported: false });
  const { targetType, targetId } = req.query;
  if (!targetType || !targetId) return res.json({ reported: false });
  const { data } = await supabase.from('reports')
    .select('id').eq('reporter_user_id', sess.username)
    .eq('target_type', targetType).eq('target_id', String(targetId))
    .maybeSingle();
  return res.json({ reported: !!data });
});

// GET /api/admin/me
app.get('/api/admin/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const sess = token ? await dbGetSession(token) : null;
  if (!sess) return res.json({ isAdmin: false });
  return res.json({ isAdmin: sess.isAdmin, username: sess.username });
});

// GET /api/admin/reports/stats (must come before /api/admin/reports/:id)
app.get('/api/admin/reports/stats', requireAdmin, async (req, res) => {
  try {
    const statuses = ['pending', 'reviewed', 'action_taken', 'dismissed'];
    const counts = {};
    for (const s of statuses) {
      const { count } = await supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', s);
      counts[s] = count || 0;
    }
    return res.json(counts);
  } catch (err) {
    return res.status(500).json({ error: 'Could not load stats.' });
  }
});

// GET /api/admin/reports
app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  const status = ['pending', 'reviewed', 'action_taken', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
  const limit  = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Number(req.query.offset) || 0;
  try {
    const { data, error, count } = await supabase.from('reports')
      .select('*', { count: 'exact' })
      .eq('status', status)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return res.json({ reports: data, total: count, status, limit, offset });
  } catch (err) {
    console.error('[admin reports list]', err);
    return res.status(500).json({ error: 'Could not load reports.' });
  }
});

// PATCH /api/admin/reports/:id
app.patch('/api/admin/reports/:id', requireAdmin, async (req, res) => {
  const { action } = req.body || {};
  const reportId = Number(req.params.id);
  if (!reportId) return res.status(400).json({ error: 'Invalid report ID.' });
  const VALID_ACTIONS = ['reviewed', 'action_taken', 'dismissed', 'ban_user', 'verify_artist', 'remove_content'];
  if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action.' });
  try {
    const { data: report } = await supabase.from('reports').select('*').eq('id', reportId).maybeSingle();
    if (!report) return res.status(404).json({ error: 'Report not found.' });

    // Founder protection
    if (action === 'ban_user' || action === 'remove_content') {
      if (report.target_type === 'user' && report.target_id?.toLowerCase() === 'slimey2017')
        return res.status(403).json({ error: 'Cannot apply automated moderation to the platform founder account.' });
      if (report.target_type === 'artist') {
        const { data: a } = await supabase.from('artists').select('account_id').eq('id', report.target_id).maybeSingle();
        if (a?.account_id?.toLowerCase() === 'slimey2017')
          return res.status(403).json({ error: 'Cannot apply automated moderation to the platform founder account.' });
      }
    }

    let newStatus = report.status;
    if (action === 'reviewed')       newStatus = 'reviewed';
    if (action === 'action_taken')   newStatus = 'action_taken';
    if (action === 'dismissed')      newStatus = 'dismissed';
    if (action === 'ban_user')       newStatus = 'action_taken';
    if (action === 'remove_content') newStatus = 'action_taken';
    if (action === 'verify_artist')  newStatus = 'action_taken';

    if (action === 'verify_artist' && report.target_type === 'artist')
      await supabase.from('artists').update({ is_verified: true }).eq('id', report.target_id);
    if (action === 'remove_content' && report.target_type === 'track')
      await supabase.from('tracks').delete().eq('id', report.target_id);
    if (action === 'remove_content' && report.target_type === 'release')
      await supabase.from('artist_releases').delete().eq('id', report.target_id);
    if (action === 'remove_content' && report.target_type === 'post')
      await supabase.from('posts').delete().eq('id', report.target_id);
    if (action === 'ban_user') {
      await supabase.from('accounts').update({ is_banned: true }).eq('username', report.target_id);
      await supabase.from('sessions').delete().eq('username', report.target_id);
    }

    const { data: updated } = await supabase.from('reports')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', reportId).select().single();
    return res.json({ report: updated, action });
  } catch (err) {
    console.error('[admin report action]', err);
    return res.status(500).json({ error: 'Could not update report.' });
  }
});

// POST /api/admin/artists/:id/verify
app.post('/api/admin/artists/:id/verify', requireAdmin, async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    await supabase.from('artists').update({ is_verified: true }).eq('id', artist.id);
    return res.json({ id: artist.id, isVerified: true });
  } catch (err) {
    console.error('[admin verify artist]', err);
    return res.status(500).json({ error: 'Could not verify artist.' });
  }
});

// DELETE /api/admin/artists/:id/verify
app.delete('/api/admin/artists/:id/verify', requireAdmin, async (req, res) => {
  try {
    const artist = await resolveArtistFromParam(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found.' });
    await supabase.from('artists').update({ is_verified: false }).eq('id', artist.id);
    return res.json({ id: artist.id, isVerified: false });
  } catch (err) {
    console.error('[admin unverify artist]', err);
    return res.status(500).json({ error: 'Could not unverify artist.' });
  }
});

// PATCH /api/admin/tracks/:trackId/explicit
app.patch('/api/admin/tracks/:trackId/explicit', requireAdmin, async (req, res) => {
  const { isExplicit } = req.body || {};
  try {
    const { data, error } = await supabase.from('tracks')
      .update({ is_explicit: !!isExplicit }).eq('id', req.params.trackId).select().single();
    if (error || !data) return res.status(404).json({ error: 'Track not found.' });
    return res.json({ id: data.id, isExplicit: data.is_explicit });
  } catch (err) {
    console.error('[admin explicit flag]', err);
    return res.status(500).json({ error: 'Could not update track.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵  FREQ v4.5 "The Social" is running`);
  console.log(`    Local:  http://localhost:${PORT}`);
  console.log(`    Health: http://localhost:${PORT}/health`);
  console.log(`    Store:  Supabase (persistent)`);
  console.log(`    © 2025–2026 FREQ / Slimey2017. All rights reserved.\n`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n⚠️  Port ${PORT} is already in use.\n   Run:  PORT=3001 node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
