import{fileURLToPath as __sdk_f}from'node:url';import{dirname as __sdk_d}from'node:path';const __filename=__sdk_f(import.meta.url);const __dirname=__sdk_d(__filename);

// ../rewind_addon_sdk/src/manifest.ts
var SDK_PROTOCOL_VERSION = 2;

// ../rewind_addon_sdk/src/addon.ts
function defineAddon(def) {
  return {
    manifest: def.manifest,
    async register(host) {
      const { resources: resources2 = {}, api } = await def.setup(host);
      return { sdk: SDK_PROTOCOL_VERSION, manifest: def.manifest, resources: resources2, api };
    }
  };
}

// src/codex.ts
import path2 from "node:path";

// src/cache.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
var TtlCache = class {
  constructor(max) {
    this.max = max;
    this.map = /* @__PURE__ */ new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return void 0;
    if (Date.now() > e.until) {
      this.map.delete(key);
      return void 0;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value, ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, until: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  entries() {
    return [...this.map.entries()];
  }
  load(entries) {
    const now = Date.now();
    for (const [k, e] of entries) if (e.until > now) this.map.set(k, e);
  }
};
var PersistedCache = class extends TtlCache {
  constructor(max, file) {
    super(max);
    this.file = file;
    this.loaded = null;
    this.timer = null;
  }
  ready() {
    if (!this.file) return Promise.resolve();
    this.loaded ??= readFile(this.file, "utf8").then((raw) => this.load(JSON.parse(raw))).catch(() => {
    });
    return this.loaded;
  }
  set(key, value, ttlMs) {
    super.set(key, value, ttlMs);
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const file = this.file;
      void mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, JSON.stringify(this.entries()))).catch(() => {
      });
    }, 2e3);
    this.timer.unref?.();
  }
};

// src/host.ts
var _host = null;
function setCodexHost(host) {
  _host = host;
}
function hasCodexHost() {
  return _host !== null;
}
function getCodexHost() {
  if (!_host) throw new Error("Codex host not configured \u2014 call setCodexHost() first");
  return _host;
}
async function codexConfig() {
  if (!_host?.getAddonConfig) return {};
  try {
    return await _host.getAddonConfig();
  } catch {
    return {};
  }
}

// src/merge.ts
var PRIORITY = {
  book: ["hardcover", "google", "openlibrary", "audible"],
  audiobook: ["audible", "hardcover", "google", "openlibrary"]
};
function norm(s) {
  return (s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/[:\-–—].*$/, "").replace(/^(the|a|an|der|die|das|le|la|les|el|il)\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function authorKey(authors) {
  const first = authors[0] ?? "";
  const parts = norm(first.includes(",") ? first.split(",")[0] : first).split(" ").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
function groupKey(b) {
  return `${norm(b.title)}|${authorKey(b.authors)}`;
}
function mergeGroup(books, kind) {
  const order = PRIORITY[kind];
  const sorted = [...books].sort((a, b) => order.indexOf(a.sources[0]) - order.indexOf(b.sources[0]));
  const pick = (k) => {
    for (const b of sorted) {
      const v = b[k];
      if (v === void 0 || v === null || v === "" || Array.isArray(v) && !v.length) continue;
      return v;
    }
    return void 0;
  };
  const best = sorted[0];
  return {
    id: best.id,
    kind,
    title: best.title,
    subtitle: pick("subtitle"),
    authors: pick("authors") ?? [],
    narrators: pick("narrators"),
    series: pick("series"),
    seriesIndex: pick("seriesIndex"),
    // The longest description reads best (providers often truncate).
    description: sorted.map((b) => b.description).filter(Boolean).sort((a, b) => b.length - a.length)[0],
    cover: pick("cover"),
    year: pick("year"),
    pages: pick("pages"),
    duration: pick("duration"),
    isbn13: pick("isbn13"),
    asin: pick("asin"),
    language: pick("language"),
    publisher: pick("publisher"),
    genres: pick("genres"),
    rating: pick("rating"),
    ratingsCount: Math.max(0, ...sorted.map((b) => b.ratingsCount ?? 0)) || void 0,
    chapters: pick("chapters"),
    sources: [...new Set(sorted.flatMap((b) => b.sources))]
  };
}
function mergeResults(lists, query, kind) {
  const groups = /* @__PURE__ */ new Map();
  let n = 0;
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const b = list[i];
      if (!b || !b.title) continue;
      const key = groupKey(b);
      const g = groups.get(key);
      if (g) g.books.push(b);
      else groups.set(key, { books: [b], firstSeen: n++ });
    }
  }
  const bare = (x) => norm(x).replace(/^(?:a|an|the|der|die|das|ein|eine|le|la|les|l|el|los|las|il|lo|gli|o|os|as|de|het|een) /, "");
  const q = bare(query);
  const merged = [...groups.values()].map((g) => ({ book: mergeGroup(g.books, kind), firstSeen: g.firstSeen }));
  const score = (b, firstSeen) => {
    const t = bare(b.title);
    const titleHit = t === q ? 3 : t.includes(q) || q.includes(t) ? 1.5 : 0;
    const authorHit = b.authors.some((a) => q.includes(norm(a).split(" ").pop() ?? "\0")) ? 1 : 0;
    return titleHit + authorHit + b.sources.length * 0.6 + Math.log10((b.ratingsCount ?? 0) + 1) * 0.9 - firstSeen * 0.02;
  };
  return merged.sort((a, b) => score(b.book, b.firstSeen) - score(a.book, a.firstSeen)).map((x) => x.book);
}

// src/log.ts
var consoleLogger = {
  info: (c, m) => console.log(`[${c}] ${m}`),
  success: (c, m) => console.log(`[${c}] ${m}`),
  warn: (c, m) => console.warn(`[${c}] ${m}`),
  error: (c, m, e) => console.error(`[${c}] ${m}`, e ?? "")
};
var sink = () => hasCodexHost() ? getCodexHost().logger : consoleLogger;
var logger = {
  info: (c, m) => sink().info(c, m),
  success: (c, m) => sink().success(c, m),
  warn: (c, m) => sink().warn(c, m),
  error: (c, m, e) => sink().error(c, m, e)
};

// src/http.ts
var UA = "Rewind-Codex/1.0 (+https://github.com/j4ckgrey/rewind_codex)";
async function getJson(url, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": UA, Accept: "application/json", ...init.headers ?? {} },
      signal: AbortSignal.timeout(init.timeoutMs ?? 1e4)
    });
    if (!res.ok) {
      logger.warn("books", `${new URL(url).host} \u2192 HTTP ${res.status}${res.status === 429 ? " (rate limit / quota)" : ""}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn("books", `${safeHost(url)} unreachable (${err.message})`);
    return null;
  }
}
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "provider";
  }
}
function stripHtml(s) {
  if (!s) return void 0;
  const t = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
  return t || void 0;
}
function yearOf(s) {
  const y = Number(/(\d{4})/.exec(String(s ?? ""))?.[1]);
  return y > 1e3 && y < 3e3 ? y : void 0;
}

// src/providers/audible.ts
var STORE = {
  en: { tld: ".com", region: "us" },
  de: { tld: ".de", region: "de" },
  fr: { tld: ".fr", region: "fr" },
  it: { tld: ".it", region: "it" },
  es: { tld: ".es", region: "es" },
  ja: { tld: ".co.jp", region: "jp" }
};
var storeFor = (lang2) => STORE[(lang2 ?? "en").slice(0, 2)] ?? STORE.en;
var GROUPS = "contributors,media,product_attrs,product_desc,series,product_extended_attrs";
var nameList = (xs) => (xs ?? []).map((x) => x.name).filter((n) => !!n);
var seq = (s) => {
  const n = Number(/(\d+(?:\.\d+)?)/.exec(s ?? "")?.[1]);
  return Number.isFinite(n) && n > 0 ? n : void 0;
};
var big = (url) => url?.replace(/\._SL\d+_\./, "._SL1000_.");
function mapProduct(p) {
  if (!p.asin || !p.title) return null;
  const series = p.series?.[0];
  return {
    id: `codex:audible:${p.asin}`,
    kind: "audiobook",
    title: p.title,
    subtitle: p.subtitle,
    authors: nameList(p.authors),
    narrators: nameList(p.narrators),
    series: series?.title,
    seriesIndex: seq(series?.sequence),
    description: stripHtml(p.publisher_summary ?? p.merchandising_summary),
    cover: big(p.product_images?.["500"] ?? Object.values(p.product_images ?? {})[0]),
    year: yearOf(p.release_date),
    duration: p.runtime_length_min ? p.runtime_length_min * 60 : void 0,
    asin: p.asin,
    language: p.language,
    publisher: p.publisher_name,
    sources: ["audible"]
  };
}
function mapAudnex(a, chapters) {
  if (!a.asin || !a.title) return null;
  return {
    id: `codex:audible:${a.asin}`,
    kind: "audiobook",
    title: a.title,
    subtitle: a.subtitle,
    authors: nameList(a.authors),
    narrators: nameList(a.narrators),
    series: a.seriesPrimary?.name,
    seriesIndex: seq(a.seriesPrimary?.position),
    description: stripHtml(a.summary ?? a.description),
    cover: big(a.image),
    year: yearOf(a.releaseDate),
    duration: a.runtimeLengthMin ? a.runtimeLengthMin * 60 : void 0,
    asin: a.asin,
    isbn13: a.isbn && a.isbn.replace(/-/g, "").length === 13 ? a.isbn.replace(/-/g, "") : void 0,
    language: a.language,
    publisher: a.publisherName,
    genres: (a.genres ?? []).map((g) => g.name).filter((n) => !!n).slice(0, 5),
    rating: a.rating ? Number(a.rating) || void 0 : void 0,
    chapters: chapters?.map((c) => ({ title: c.title ?? "", start: c.startOffsetSec ?? 0 })),
    sources: ["audible"]
  };
}
var audible = {
  name: "audible",
  available: () => true,
  async search(query, opts) {
    if (opts.kind !== "audiobook") return [];
    const { tld } = storeFor(opts.lang);
    const params = new URLSearchParams({ num_results: String(Math.min(50, opts.limit ?? 20)), products_sort_by: "Relevance", keywords: query, response_groups: GROUPS });
    const j = await getJson(`https://api.audible${tld}/1.0/catalog/products?${params}`);
    return (j?.products ?? []).map(mapProduct).filter((b) => !!b);
  },
  async get(asin, opts) {
    const { region } = storeFor(opts.lang);
    const base = `https://api.audnex.us/books/${encodeURIComponent(asin.toUpperCase())}`;
    const [book, chapters] = await Promise.all([
      getJson(`${base}?region=${region}`),
      getJson(`${base}/chapters?region=${region}`)
    ]);
    return book ? mapAudnex(book, chapters?.chapters) : null;
  }
};
async function audibleBrowse(sort, lang2, keywords, limit = 40) {
  const { tld } = storeFor(lang2);
  const params = new URLSearchParams({ num_results: String(Math.min(50, limit)), products_sort_by: sort, response_groups: GROUPS });
  if (keywords) params.set("keywords", keywords);
  const j = await getJson(`https://api.audible${tld}/1.0/catalog/products?${params}`);
  return (j?.products ?? []).map(mapProduct).filter((b) => !!b);
}

// src/providers/googleBooks.ts
var BASE = "https://www.googleapis.com/books/v1/volumes";
function bestCover(links) {
  const url = links?.extraLarge ?? links?.large ?? links?.medium ?? links?.small ?? links?.thumbnail;
  return url?.replace(/^http:/, "https:").replace(/&edge=curl/, "");
}
function mapVolume(v) {
  const i = v.volumeInfo;
  if (!v.id || !i?.title) return null;
  return {
    id: `codex:google:${v.id}`,
    kind: "book",
    title: i.title,
    subtitle: i.subtitle,
    authors: i.authors ?? [],
    description: stripHtml(i.description),
    cover: bestCover(i.imageLinks),
    year: yearOf(i.publishedDate),
    pages: i.pageCount || void 0,
    isbn13: i.industryIdentifiers?.find((x) => x.type === "ISBN_13")?.identifier,
    language: i.language,
    publisher: i.publisher,
    genres: i.categories,
    rating: i.averageRating,
    ratingsCount: i.ratingsCount,
    sources: ["google"]
  };
}
var keyOf = (cfg) => (cfg.codex_google_books_key ?? "").trim();
var googleBooks = {
  name: "google",
  available: (cfg) => !!keyOf(cfg),
  async search(query, opts, cfg) {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(40, opts.limit ?? 20)), printType: "books", key: keyOf(cfg) });
    const j = await getJson(`${BASE}?${params}`);
    return (j?.items ?? []).map(mapVolume).filter((b) => !!b).map((b) => ({ ...b, kind: opts.kind }));
  },
  async get(id, opts, cfg) {
    const v = await getJson(`${BASE}/${encodeURIComponent(id)}?key=${encodeURIComponent(keyOf(cfg))}`);
    const b = v ? mapVolume(v) : null;
    return b ? { ...b, kind: opts.kind } : null;
  }
};

// src/providers/hardcover.ts
var ENDPOINT = "https://api.hardcover.app/v1/graphql";
var SEARCH = `query Search($query: String!) {
  search(query: $query, per_page: 20, query_type: "book",
    fields: "title,isbns,series_names,author_names,alternative_titles",
    weights: "5,1,3,5,1", sort: "_text_match:desc,ratings_count:desc") { ids }
}`;
var WORK_FIELDS = `
  id title subtitle description release_date rating ratings_count
  cached_tags(path: "$.Genre")
  cached_image(path: "url")
  contributions { contribution author { name } }
  book_series { position series { name } }
  default_physical_edition { isbn_13 pages language { code3 } publisher { name } }
  default_ebook_edition { isbn_13 pages }
  default_audio_edition { asin audio_seconds contributions { contribution author { name } } }`;
var BOOKS = `query Books($ids: [Int!]) { books(where: { id: { _in: $ids } }) { ${WORK_FIELDS} } }`;
function tags(raw) {
  if (!Array.isArray(raw)) return void 0;
  const out = raw.map((t) => typeof t === "string" ? t : t?.tag).filter((t) => !!t);
  return out.length ? out.slice(0, 6) : void 0;
}
var names = (cs, role) => (cs ?? []).filter((c) => role(c.contribution ?? "")).map((c) => c.author?.name).filter((n) => !!n);
function mapWork(w, kind) {
  if (!w.id || !w.title) return null;
  const series = w.book_series?.find((s) => s.series?.name);
  const phys = w.default_physical_edition;
  const audio = w.default_audio_edition;
  const authors = names(w.contributions, (c) => !c || /author/i.test(c));
  return {
    id: `codex:hardcover:${w.id}`,
    kind,
    title: w.title,
    subtitle: w.subtitle ?? void 0,
    authors,
    narrators: kind === "audiobook" ? names(audio?.contributions, (c) => /narrat|reader/i.test(c)) : void 0,
    series: series?.series?.name,
    seriesIndex: series?.position ?? void 0,
    description: stripHtml(w.description),
    cover: w.cached_image || void 0,
    year: yearOf(w.release_date),
    pages: phys?.pages ?? w.default_ebook_edition?.pages ?? void 0,
    duration: kind === "audiobook" ? audio?.audio_seconds ?? void 0 : void 0,
    isbn13: phys?.isbn_13 ?? w.default_ebook_edition?.isbn_13 ?? void 0,
    asin: audio?.asin ?? void 0,
    language: phys?.language?.code3,
    publisher: phys?.publisher?.name,
    genres: tags(w.cached_tags),
    rating: w.rating ? Math.round(w.rating * 10) / 10 : void 0,
    ratingsCount: w.ratings_count ?? void 0,
    sources: ["hardcover"]
  };
}
function token(cfg) {
  const t = (cfg.codex_hardcover_token ?? "").trim();
  if (!t) return "";
  return /^bearer\s/i.test(t) ? t : `Bearer ${t}`;
}
async function gql(query, variables, cfg) {
  const j = await getJson(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token(cfg) },
    body: JSON.stringify({ query, variables })
  });
  return j?.data ?? null;
}
var hardcover = {
  name: "hardcover",
  available: (cfg) => !!token(cfg),
  async search(query, opts, cfg) {
    const found = await gql(SEARCH, { query }, cfg);
    const raw = found?.search?.ids;
    const ids = (Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isFinite(n)).slice(0, opts.limit ?? 20);
    if (!ids.length) return [];
    const data = await gql(BOOKS, { ids }, cfg);
    const byId = new Map((data?.books ?? []).map((b) => [b.id, b]));
    return ids.map((id) => byId.get(id)).map((w) => w ? mapWork(w, opts.kind) : null).filter((b) => !!b);
  },
  async get(id, opts, cfg) {
    const data = await gql(BOOKS, { ids: [Number(id)] }, cfg);
    const w = data?.books?.[0];
    return w ? mapWork(w, opts.kind) : null;
  }
};

// src/providers/openLibrary.ts
var BASE2 = "https://openlibrary.org";
var FIELDS = "key,title,subtitle,author_name,first_publish_year,cover_i,isbn,number_of_pages_median,language,subject,ratings_average,ratings_count";
var realAuthors = (names2) => (names2 ?? []).filter((a) => !/sparknotes|cliffsnotes|litcharts|shmoop|summary/i.test(a));
var cover = (id) => id && id > 0 ? `https://covers.openlibrary.org/b/id/${id}-L.jpg` : void 0;
var workId = (key) => (key ?? "").replace(/^\/works\//, "");
function mapSearchDoc(d) {
  const id = workId(d.key);
  if (!id || !d.title) return null;
  return {
    id: `codex:openlibrary:${id}`,
    kind: "book",
    title: d.title,
    subtitle: d.subtitle,
    authors: realAuthors(d.author_name),
    cover: cover(d.cover_i),
    year: d.first_publish_year,
    pages: d.number_of_pages_median,
    isbn13: d.isbn?.find((i) => i.length === 13),
    genres: d.subject?.slice(0, 5),
    rating: d.ratings_average ? Math.round(d.ratings_average * 10) / 10 : void 0,
    ratingsCount: d.ratings_count,
    sources: ["openlibrary"]
  };
}
function mapWork2(w, authors) {
  const id = workId(w.key);
  if (!id || !w.title) return null;
  const desc = typeof w.description === "string" ? w.description : w.description?.value;
  return {
    id: `codex:openlibrary:${id}`,
    kind: "book",
    title: w.title,
    subtitle: w.subtitle,
    authors: realAuthors(authors),
    // Strip the "([source][1])" footnotes Open Library descriptions often carry.
    description: stripHtml(desc?.replace(/\(\[source\]\[\d+\]\)[\s\S]*$/, "").replace(/-{3,}[\s\S]*$/, "")),
    cover: cover(w.covers?.find((c) => c > 0)),
    year: Number(/(\d{4})/.exec(w.first_publish_date ?? "")?.[1]) || void 0,
    genres: w.subjects?.slice(0, 5),
    sources: ["openlibrary"]
  };
}
var openLibrary = {
  name: "openlibrary",
  available: () => true,
  async search(query, opts) {
    if (opts.kind !== "book") return [];
    const params = new URLSearchParams({ q: query, limit: String(opts.limit ?? 20), fields: FIELDS });
    const j = await getJson(`${BASE2}/search.json?${params}`);
    return (j?.docs ?? []).map(mapSearchDoc).filter((b) => !!b);
  },
  async get(id) {
    const w = await getJson(`${BASE2}/works/${encodeURIComponent(id)}.json`);
    if (!w) return null;
    const names2 = await Promise.all(
      (w.authors ?? []).slice(0, 3).map(async (a) => {
        const key = a.author?.key;
        if (!key) return null;
        return (await getJson(`${BASE2}${key}.json`))?.name ?? null;
      })
    );
    const book = mapWork2(w, names2.filter((n) => !!n));
    if (book && (!book.cover || !book.authors.length || !book.pages)) {
      const params = new URLSearchParams({ q: `key:/works/${id}`, fields: FIELDS, limit: "1" });
      const doc = (await getJson(`${BASE2}/search.json?${params}`))?.docs?.[0];
      const extra = doc ? mapSearchDoc(doc) : null;
      if (extra) {
        book.cover ??= extra.cover;
        if (!book.authors.length) book.authors = extra.authors;
        book.pages ??= extra.pages;
        book.year ??= extra.year;
        book.rating ??= extra.rating;
        book.ratingsCount ??= extra.ratingsCount;
      }
    }
    return book;
  }
};
async function olTrending(period, limit = 40) {
  const j = await getJson(`${BASE2}/trending/${period}.json?limit=${limit}`);
  return (j?.works ?? []).map(mapSearchDoc).filter((b) => !!b);
}
async function olSubject(subject, limit = 40) {
  const j = await getJson(`${BASE2}/subjects/${encodeURIComponent(subject)}.json?limit=${limit}`);
  return (j?.works ?? []).map(
    (w) => mapSearchDoc({
      key: w.key,
      title: w.title,
      cover_i: w.cover_id,
      first_publish_year: w.first_publish_year,
      author_name: (w.authors ?? []).map((a) => a.name).filter((n) => !!n)
    })
  ).filter((b) => !!b);
}

// src/codex.ts
var PROVIDERS = [hardcover, audible, googleBooks, openLibrary];
var byName = new Map(PROVIDERS.map((p) => [p.name, p]));
var DAY = 864e5;
var searches = new TtlCache(500);
var details = null;
function detailCache() {
  if (!details) {
    const dir = hasCodexHost() ? getCodexHost().dataDir : void 0;
    details = new PersistedCache(5e3, dir ? path2.join(dir, "addons", "codex", "books.json") : null);
  }
  return details;
}
async function searchBooks(query, opts) {
  const q = query.trim();
  if (!q) return [];
  const key = `${opts.kind}|${opts.lang ?? ""}|${q.toLowerCase()}`;
  const hit = searches.get(key);
  if (hit) return hit;
  const cfg = await codexConfig();
  const active = PROVIDERS.filter((p) => p.available(cfg));
  const lists = await Promise.all(active.map((p) => p.search(q, { ...opts, limit: opts.limit ?? 20 }, cfg).catch(() => [])));
  const out = mergeResults(lists, q, opts.kind).slice(0, opts.limit ?? 40);
  searches.set(key, out, DAY);
  return out;
}
function parseId(id) {
  const m = /^codex:(hardcover|google|openlibrary|audible):(.+)$/.exec(id);
  return m ? { provider: m[1], providerId: m[2] } : null;
}
async function getBook(id, kind, lang2) {
  const parsed = parseId(id);
  if (!parsed) return null;
  const cache2 = detailCache();
  await cache2.ready();
  const cacheKey = `${kind}|${id}`;
  const cached = cache2.get(cacheKey);
  if (cached) return cached;
  const cfg = await codexConfig();
  const provider = byName.get(parsed.provider);
  if (!provider || !provider.available(cfg)) return null;
  const opts = { kind, lang: lang2 };
  const primary = await provider.get(parsed.providerId, opts, cfg).catch(() => null);
  if (!primary) return null;
  const others = PROVIDERS.filter((p) => p !== provider && p.available(cfg));
  const query = [primary.title, primary.authors[0]].filter(Boolean).join(" ");
  const key = groupKey(primary);
  const extra = await Promise.all(
    others.map((p) => p.search(query, { ...opts, limit: 8 }, cfg).then((list) => list.filter((b) => groupKey(b) === key)).catch(() => []))
  );
  const merged = { ...mergeGroup([primary, ...extra.flat()], kind), id: primary.id };
  cache2.set(cacheKey, merged, 7 * DAY);
  return merged;
}

// src/discover.ts
import path3 from "node:path";
var GENRES = [
  { id: "fantasy", ol: "fantasy", audible: { en: "fantasy", de: "Fantasy" }, names: { en: "Fantasy", de: "Fantasy", es: "Fantas\xEDa", fr: "Fantasy", it: "Fantasy", pt: "Fantasia", nl: "Fantasy", zh: "\u5947\u5E7B" } },
  { id: "science_fiction", ol: "science_fiction", audible: { en: "science fiction", de: "Science-Fiction" }, names: { en: "Science fiction", de: "Science-Fiction", es: "Ciencia ficci\xF3n", fr: "Science-fiction", it: "Fantascienza", pt: "Fic\xE7\xE3o cient\xEDfica", nl: "Sciencefiction", zh: "\u79D1\u5E7B" } },
  { id: "thriller", ol: "thriller", audible: { en: "thriller", de: "Thriller" }, names: { en: "Thrillers", de: "Thriller", es: "Suspense", fr: "Thrillers", it: "Thriller", pt: "Thrillers", nl: "Thrillers", zh: "\u60CA\u609A" } },
  { id: "mystery", ol: "mystery_and_detective_stories", audible: { en: "mystery", de: "Krimi" }, names: { en: "Mystery & crime", de: "Krimis", es: "Misterio y crimen", fr: "Polars", it: "Gialli", pt: "Policiais", nl: "Misdaad", zh: "\u63A8\u7406" } },
  { id: "romance", ol: "romance", audible: { en: "romance", de: "Liebesroman" }, names: { en: "Romance", de: "Liebesromane", es: "Rom\xE1ntica", fr: "Romance", it: "Romanzi rosa", pt: "Romance", nl: "Romantiek", zh: "\u8A00\u60C5" } },
  { id: "horror", ol: "horror", audible: { en: "horror", de: "Horror" }, names: { en: "Horror", de: "Horror", es: "Terror", fr: "Horreur", it: "Horror", pt: "Terror", nl: "Horror", zh: "\u6050\u6016" } },
  { id: "historical", ol: "historical_fiction", audible: { en: "historical fiction", de: "historischer Roman" }, names: { en: "Historical fiction", de: "Historische Romane", es: "Novela hist\xF3rica", fr: "Romans historiques", it: "Romanzi storici", pt: "Fic\xE7\xE3o hist\xF3rica", nl: "Historische romans", zh: "\u5386\u53F2\u5C0F\u8BF4" } },
  { id: "biography", ol: "biography", audible: { en: "biography", de: "Biografie" }, names: { en: "Biographies", de: "Biografien", es: "Biograf\xEDas", fr: "Biographies", it: "Biografie", pt: "Biografias", nl: "Biografie\xEBn", zh: "\u4F20\u8BB0" } },
  { id: "self_help", ol: "self-help", audible: { en: "self help", de: "Ratgeber" }, names: { en: "Self-help", de: "Ratgeber", es: "Autoayuda", fr: "D\xE9veloppement personnel", it: "Crescita personale", pt: "Autoajuda", nl: "Zelfhulp", zh: "\u81EA\u6211\u63D0\u5347" } },
  { id: "children", ol: "children", audible: { en: "kids", de: "Kinder" }, names: { en: "Kids", de: "Kinder", es: "Infantil", fr: "Enfants", it: "Bambini", pt: "Infantil", nl: "Kinderen", zh: "\u513F\u7AE5" } }
];
var ALL_LISTS = [
  {
    id: "trending-week",
    kind: "book",
    group: "trending",
    perLanguage: false,
    fetch: () => olTrending("weekly"),
    name: "Trending this week",
    names: { en: "Trending this week", de: "Diese Woche im Trend", es: "Tendencia esta semana", fr: "Tendance cette semaine", it: "Di tendenza questa settimana", pt: "Em alta esta semana", nl: "Trending deze week", zh: "\u672C\u5468\u70ED\u95E8" }
  },
  {
    id: "trending-month",
    kind: "book",
    group: "trending",
    perLanguage: false,
    fetch: () => olTrending("monthly"),
    name: "Trending this month",
    names: { en: "Trending this month", de: "Diesen Monat im Trend", es: "Tendencia este mes", fr: "Tendance ce mois-ci", it: "Di tendenza questo mese", pt: "Em alta este m\xEAs", nl: "Trending deze maand", zh: "\u672C\u6708\u70ED\u95E8" }
  },
  {
    id: "popular-year",
    kind: "book",
    group: "trending",
    perLanguage: false,
    fetch: () => olTrending("yearly"),
    name: "Most read this year",
    names: { en: "Most read this year", de: "Meistgelesen dieses Jahr", es: "Lo m\xE1s le\xEDdo del a\xF1o", fr: "Les plus lus de l'ann\xE9e", it: "I pi\xF9 letti dell'anno", pt: "Os mais lidos do ano", nl: "Meest gelezen dit jaar", zh: "\u5E74\u5EA6\u6700\u5E38\u8BFB" }
  },
  ...GENRES.map((g) => ({
    id: `genre-${g.id}`,
    kind: "book",
    group: "genres",
    perLanguage: false,
    fetch: () => olSubject(g.ol),
    name: g.names.en,
    names: g.names
  })),
  {
    id: "bestsellers",
    kind: "audiobook",
    group: "charts",
    perLanguage: true,
    fetch: (lang2) => audibleBrowse("BestSellers", lang2),
    name: "Bestsellers",
    names: { en: "Bestsellers", de: "Bestseller", es: "M\xE1s vendidos", fr: "Meilleures ventes", it: "Pi\xF9 venduti", pt: "Mais vendidos", nl: "Bestsellers", zh: "\u7545\u9500\u699C" }
  },
  {
    id: "new-releases",
    kind: "audiobook",
    group: "charts",
    perLanguage: true,
    fetch: (lang2) => audibleBrowse("-ReleaseDate", lang2),
    name: "New releases",
    names: { en: "New releases", de: "Neuerscheinungen", es: "Novedades", fr: "Nouveaut\xE9s", it: "Novit\xE0", pt: "Novidades", nl: "Nieuw verschenen", zh: "\u65B0\u54C1" }
  },
  ...GENRES.map((g) => ({
    id: `genre-${g.id}`,
    kind: "audiobook",
    group: "genres",
    perLanguage: true,
    fetch: (lang2) => audibleBrowse("BestSellers", lang2, g.audible[lang2.slice(0, 2)] ?? g.audible.en),
    name: g.names.en,
    names: g.names
  }))
];
var GROUP_ORDER = ["trending", "charts", "genres"];
var DISCOVER_LISTS = [...ALL_LISTS].sort(
  (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (a.kind === b.kind ? 0 : a.kind === "book" ? -1 : 1)
);
var WEEK = 7 * 864e5;
var cache = null;
var seenLangs = /* @__PURE__ */ new Set(["en"]);
function store() {
  if (!cache) {
    const dir = hasCodexHost() ? getCodexHost().dataDir : void 0;
    cache = new PersistedCache(400, dir ? path3.join(dir, "addons", "codex", "discover.json") : null);
  }
  return cache;
}
var keyOf2 = (l, lang2) => `${l.kind}|${l.id}|${l.perLanguage ? lang2 : "*"}`;
function findList(kind, id) {
  return DISCOVER_LISTS.find((l) => l.kind === kind && l.id === id);
}
async function discoverList(kind, id, lang2 = "en") {
  const list = findList(kind, id);
  if (!list) return [];
  const short = lang2.slice(0, 2) || "en";
  seenLangs.add(short);
  const c = store();
  await c.ready();
  const hit = c.get(keyOf2(list, short));
  if (hit) return hit;
  const books = await list.fetch(short).catch(() => []);
  if (books.length) c.set(keyOf2(list, short), books, 8 * 24 * 36e5);
  return books;
}
async function refreshDiscover() {
  const c = store();
  await c.ready();
  let lists = 0;
  let books = 0;
  for (const list of DISCOVER_LISTS) {
    for (const lang2 of list.perLanguage ? [...seenLangs] : ["en"]) {
      const fresh = await list.fetch(lang2).catch(() => []);
      if (!fresh.length) continue;
      c.set(keyOf2(list, lang2), fresh, WEEK + 864e5);
      lists++;
      books += fresh.length;
    }
  }
  logger.info("books", `Discover refreshed: ${lists} lists, ${books} books`);
  return { lists, books };
}

// src/resources.ts
function kindOf(req) {
  if (req.type === "book") return "book";
  if (req.type === "audiobook") return "audiobook";
  throw new Error(`The Codex serves types "book" and "audiobook", not "${req.type}"`);
}
var lang = (req) => typeof req.extra.lang === "string" ? req.extra.lang : void 0;
function toMeta(b) {
  return {
    id: b.id,
    type: b.kind,
    name: b.title,
    subtitle: b.authors.join(", ") || void 0,
    description: b.description,
    poster: b.cover,
    posterShape: "portrait",
    releaseInfo: b.year ? String(b.year) : void 0,
    duration: b.duration,
    genres: b.genres,
    // Book extras — passed through untouched.
    bookSubtitle: b.subtitle,
    authors: b.authors,
    narrators: b.narrators,
    series: b.series,
    seriesIndex: b.seriesIndex,
    pages: b.pages,
    isbn13: b.isbn13,
    asin: b.asin,
    language: b.language,
    publisher: b.publisher,
    rating: b.rating,
    ratingsCount: b.ratingsCount,
    chapters: b.chapters,
    sources: b.sources
  };
}
var resources = {
  async search(req) {
    const limit = Number(req.extra.limit) || 40;
    return { metas: (await searchBooks(req.id, { kind: kindOf(req), lang: lang(req), limit })).map(toMeta) };
  },
  async meta(req) {
    const b = await getBook(req.id, kindOf(req), lang(req));
    return { meta: b ? toMeta(b) : null };
  },
  /** Discover lists (manifest `catalogs`): id = list id. */
  async catalog(req) {
    return { metas: (await discoverList(kindOf(req), req.id, lang(req))).map(toMeta) };
  },
  /** Automations declared in the manifest. */
  async automation(req) {
    if (req.id === "refresh-discover") {
      const r = await refreshDiscover();
      return { ok: true, message: `${r.lists} lists, ${r.books} books` };
    }
    throw new Error(`unknown automation "${req.id}"`);
  },
  async artwork(req) {
    const b = await getBook(req.id, kindOf(req), lang(req));
    return { artwork: { poster: b?.cover ?? null } };
  }
};

// manifest.json
var manifest_default = {
  id: "rewind.codex",
  name: "The Codex",
  version: "1.1.2",
  description: "Book + audiobook metadata for Rewind \u2014 one search across Hardcover, Google Books, Open Library and Audible (Audnexus), merged: covers, authors, narrators, series, descriptions, chapters. Powers the Books space; The Forge finds the releases.",
  resources: [
    "search",
    "meta",
    "artwork",
    "catalog",
    "automation"
  ],
  types: [
    "book",
    "audiobook"
  ],
  idPrefixes: [
    "codex:"
  ],
  provides: {
    metadata: [
      "books"
    ],
    artwork: [
      "books"
    ]
  },
  rewind: {
    kind: "books",
    sdk: 2,
    repo: "j4ckgrey/rewind_codex",
    branch: "main",
    bundlePath: "dist/index.mjs",
    bundleUrl: "https://raw.githubusercontent.com/j4ckgrey/rewind_codex/main/dist/index.mjs",
    tabs: [],
    configKeys: [
      {
        key: "codex_hardcover_token",
        label: "Hardcover API token",
        category: "Books",
        card: "codex",
        description: "Optional, recommended. Best covers, series and ratings. hardcover.app \u2192 Settings \u2192 Hardcover API (expires every 1 January)."
      },
      {
        key: "codex_google_books_key",
        label: "Google Books API key",
        category: "Books",
        card: "codex",
        description: "Optional. Strong for German and other non-English books. Free key from Google Cloud Console \u2192 Books API."
      }
    ],
    features: [
      "books"
    ],
    automations: [
      {
        id: "refresh-discover",
        name: "Refresh book Discover lists",
        description: "Rebuilds the Books Discover page \u2014 trending, bestsellers, new releases and genre shelves \u2014 from Open Library and Audible.",
        intervalMinutes: 10080
      }
    ]
  },
  catalogs: [
    {
      id: "trending-week",
      type: "book",
      name: "Trending this week",
      names: {
        en: "Trending this week",
        de: "Diese Woche im Trend",
        es: "Tendencia esta semana",
        fr: "Tendance cette semaine",
        it: "Di tendenza questa settimana",
        pt: "Em alta esta semana",
        nl: "Trending deze week",
        zh: "\u672C\u5468\u70ED\u95E8"
      },
      group: "trending",
      groupNames: {
        en: "Trending",
        de: "Im Trend",
        es: "Tendencias",
        fr: "Tendances",
        it: "Di tendenza",
        pt: "Em alta",
        nl: "Trending",
        zh: "\u70ED\u95E8"
      }
    },
    {
      id: "trending-month",
      type: "book",
      name: "Trending this month",
      names: {
        en: "Trending this month",
        de: "Diesen Monat im Trend",
        es: "Tendencia este mes",
        fr: "Tendance ce mois-ci",
        it: "Di tendenza questo mese",
        pt: "Em alta este m\xEAs",
        nl: "Trending deze maand",
        zh: "\u672C\u6708\u70ED\u95E8"
      },
      group: "trending",
      groupNames: {
        en: "Trending",
        de: "Im Trend",
        es: "Tendencias",
        fr: "Tendances",
        it: "Di tendenza",
        pt: "Em alta",
        nl: "Trending",
        zh: "\u70ED\u95E8"
      }
    },
    {
      id: "popular-year",
      type: "book",
      name: "Most read this year",
      names: {
        en: "Most read this year",
        de: "Meistgelesen dieses Jahr",
        es: "Lo m\xE1s le\xEDdo del a\xF1o",
        fr: "Les plus lus de l'ann\xE9e",
        it: "I pi\xF9 letti dell'anno",
        pt: "Os mais lidos do ano",
        nl: "Meest gelezen dit jaar",
        zh: "\u5E74\u5EA6\u6700\u5E38\u8BFB"
      },
      group: "trending",
      groupNames: {
        en: "Trending",
        de: "Im Trend",
        es: "Tendencias",
        fr: "Tendances",
        it: "Di tendenza",
        pt: "Em alta",
        nl: "Trending",
        zh: "\u70ED\u95E8"
      }
    },
    {
      id: "bestsellers",
      type: "audiobook",
      name: "Bestsellers",
      names: {
        en: "Bestsellers",
        de: "Bestseller",
        es: "M\xE1s vendidos",
        fr: "Meilleures ventes",
        it: "Pi\xF9 venduti",
        pt: "Mais vendidos",
        nl: "Bestsellers",
        zh: "\u7545\u9500\u699C"
      },
      group: "charts",
      groupNames: {
        en: "Charts",
        de: "Charts",
        es: "Listas",
        fr: "Classements",
        it: "Classifiche",
        pt: "Tops",
        nl: "Hitlijsten",
        zh: "\u6392\u884C\u699C"
      }
    },
    {
      id: "new-releases",
      type: "audiobook",
      name: "New releases",
      names: {
        en: "New releases",
        de: "Neuerscheinungen",
        es: "Novedades",
        fr: "Nouveaut\xE9s",
        it: "Novit\xE0",
        pt: "Novidades",
        nl: "Nieuw verschenen",
        zh: "\u65B0\u54C1"
      },
      group: "charts",
      groupNames: {
        en: "Charts",
        de: "Charts",
        es: "Listas",
        fr: "Classements",
        it: "Classifiche",
        pt: "Tops",
        nl: "Hitlijsten",
        zh: "\u6392\u884C\u699C"
      }
    },
    {
      id: "genre-fantasy",
      type: "book",
      name: "Fantasy",
      names: {
        en: "Fantasy",
        de: "Fantasy",
        es: "Fantas\xEDa",
        fr: "Fantasy",
        it: "Fantasy",
        pt: "Fantasia",
        nl: "Fantasy",
        zh: "\u5947\u5E7B"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-science_fiction",
      type: "book",
      name: "Science fiction",
      names: {
        en: "Science fiction",
        de: "Science-Fiction",
        es: "Ciencia ficci\xF3n",
        fr: "Science-fiction",
        it: "Fantascienza",
        pt: "Fic\xE7\xE3o cient\xEDfica",
        nl: "Sciencefiction",
        zh: "\u79D1\u5E7B"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-thriller",
      type: "book",
      name: "Thrillers",
      names: {
        en: "Thrillers",
        de: "Thriller",
        es: "Suspense",
        fr: "Thrillers",
        it: "Thriller",
        pt: "Thrillers",
        nl: "Thrillers",
        zh: "\u60CA\u609A"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-mystery",
      type: "book",
      name: "Mystery & crime",
      names: {
        en: "Mystery & crime",
        de: "Krimis",
        es: "Misterio y crimen",
        fr: "Polars",
        it: "Gialli",
        pt: "Policiais",
        nl: "Misdaad",
        zh: "\u63A8\u7406"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-romance",
      type: "book",
      name: "Romance",
      names: {
        en: "Romance",
        de: "Liebesromane",
        es: "Rom\xE1ntica",
        fr: "Romance",
        it: "Romanzi rosa",
        pt: "Romance",
        nl: "Romantiek",
        zh: "\u8A00\u60C5"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-horror",
      type: "book",
      name: "Horror",
      names: {
        en: "Horror",
        de: "Horror",
        es: "Terror",
        fr: "Horreur",
        it: "Horror",
        pt: "Terror",
        nl: "Horror",
        zh: "\u6050\u6016"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-historical",
      type: "book",
      name: "Historical fiction",
      names: {
        en: "Historical fiction",
        de: "Historische Romane",
        es: "Novela hist\xF3rica",
        fr: "Romans historiques",
        it: "Romanzi storici",
        pt: "Fic\xE7\xE3o hist\xF3rica",
        nl: "Historische romans",
        zh: "\u5386\u53F2\u5C0F\u8BF4"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-biography",
      type: "book",
      name: "Biographies",
      names: {
        en: "Biographies",
        de: "Biografien",
        es: "Biograf\xEDas",
        fr: "Biographies",
        it: "Biografie",
        pt: "Biografias",
        nl: "Biografie\xEBn",
        zh: "\u4F20\u8BB0"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-self_help",
      type: "book",
      name: "Self-help",
      names: {
        en: "Self-help",
        de: "Ratgeber",
        es: "Autoayuda",
        fr: "D\xE9veloppement personnel",
        it: "Crescita personale",
        pt: "Autoajuda",
        nl: "Zelfhulp",
        zh: "\u81EA\u6211\u63D0\u5347"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-children",
      type: "book",
      name: "Kids",
      names: {
        en: "Kids",
        de: "Kinder",
        es: "Infantil",
        fr: "Enfants",
        it: "Bambini",
        pt: "Infantil",
        nl: "Kinderen",
        zh: "\u513F\u7AE5"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-fantasy",
      type: "audiobook",
      name: "Fantasy",
      names: {
        en: "Fantasy",
        de: "Fantasy",
        es: "Fantas\xEDa",
        fr: "Fantasy",
        it: "Fantasy",
        pt: "Fantasia",
        nl: "Fantasy",
        zh: "\u5947\u5E7B"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-science_fiction",
      type: "audiobook",
      name: "Science fiction",
      names: {
        en: "Science fiction",
        de: "Science-Fiction",
        es: "Ciencia ficci\xF3n",
        fr: "Science-fiction",
        it: "Fantascienza",
        pt: "Fic\xE7\xE3o cient\xEDfica",
        nl: "Sciencefiction",
        zh: "\u79D1\u5E7B"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-thriller",
      type: "audiobook",
      name: "Thrillers",
      names: {
        en: "Thrillers",
        de: "Thriller",
        es: "Suspense",
        fr: "Thrillers",
        it: "Thriller",
        pt: "Thrillers",
        nl: "Thrillers",
        zh: "\u60CA\u609A"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-mystery",
      type: "audiobook",
      name: "Mystery & crime",
      names: {
        en: "Mystery & crime",
        de: "Krimis",
        es: "Misterio y crimen",
        fr: "Polars",
        it: "Gialli",
        pt: "Policiais",
        nl: "Misdaad",
        zh: "\u63A8\u7406"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-romance",
      type: "audiobook",
      name: "Romance",
      names: {
        en: "Romance",
        de: "Liebesromane",
        es: "Rom\xE1ntica",
        fr: "Romance",
        it: "Romanzi rosa",
        pt: "Romance",
        nl: "Romantiek",
        zh: "\u8A00\u60C5"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-horror",
      type: "audiobook",
      name: "Horror",
      names: {
        en: "Horror",
        de: "Horror",
        es: "Terror",
        fr: "Horreur",
        it: "Horror",
        pt: "Terror",
        nl: "Horror",
        zh: "\u6050\u6016"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-historical",
      type: "audiobook",
      name: "Historical fiction",
      names: {
        en: "Historical fiction",
        de: "Historische Romane",
        es: "Novela hist\xF3rica",
        fr: "Romans historiques",
        it: "Romanzi storici",
        pt: "Fic\xE7\xE3o hist\xF3rica",
        nl: "Historische romans",
        zh: "\u5386\u53F2\u5C0F\u8BF4"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-biography",
      type: "audiobook",
      name: "Biographies",
      names: {
        en: "Biographies",
        de: "Biografien",
        es: "Biograf\xEDas",
        fr: "Biographies",
        it: "Biografie",
        pt: "Biografias",
        nl: "Biografie\xEBn",
        zh: "\u4F20\u8BB0"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-self_help",
      type: "audiobook",
      name: "Self-help",
      names: {
        en: "Self-help",
        de: "Ratgeber",
        es: "Autoayuda",
        fr: "D\xE9veloppement personnel",
        it: "Crescita personale",
        pt: "Autoajuda",
        nl: "Zelfhulp",
        zh: "\u81EA\u6211\u63D0\u5347"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    },
    {
      id: "genre-children",
      type: "audiobook",
      name: "Kids",
      names: {
        en: "Kids",
        de: "Kinder",
        es: "Infantil",
        fr: "Enfants",
        it: "Bambini",
        pt: "Infantil",
        nl: "Kinderen",
        zh: "\u513F\u7AE5"
      },
      group: "genres",
      groupNames: {
        en: "Genres",
        de: "Genres",
        es: "G\xE9neros",
        fr: "Genres",
        it: "Generi",
        pt: "G\xE9neros",
        nl: "Genres",
        zh: "\u7C7B\u578B"
      }
    }
  ]
};

// src/plugin.ts
function buildApi() {
  return {
    async search(query, kind, lang2, limit = 40) {
      return (await searchBooks(query, { kind, lang: lang2, limit })).map(toMeta);
    },
    async get(id, kind, lang2) {
      const b = await getBook(id, kind, lang2);
      return b ? toMeta(b) : null;
    }
  };
}
var addon = defineAddon({
  manifest: manifest_default,
  setup(host) {
    setCodexHost(host);
    return { api: buildApi(), resources };
  }
});
var manifest = addon.manifest;
var register = addon.register;
export {
  addon,
  manifest,
  register
};
