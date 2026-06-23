/* ============================================================
 * JaegoData — 백데이터(중앙 제품 시트) 클라이언트 (재사용 모듈)
 * ------------------------------------------------------------
 * jaego중앙 같은 중앙 스프레드시트를 워커(Apps Script 프록시) 너머로
 * 읽고(getAll) · 조회하고(lookup) · 바코드를 등록(register)한다.
 * 어떤 프로젝트든 이 모듈만 끼우면 같은 백데이터를 쓸 수 있다.
 *
 * 의존성: BarcodeUtils (정규화/변형/뒷자리). barcode-scanner.min.js 또는
 *         barcode-utils.js 를 먼저 로드하면 자동으로 사용한다.
 *
 * 사용:
 *   const data = JaegoData.create({ sheetUrl: 'https://.../proxy' });
 *   await data.load();                 // 제품 전체 로드(+localStorage 캐시)
 *   data.products;                     // 배열
 *   data.noBarcode();                  // 이름만 있고 바코드 없는 품목(매칭 대상)
 *   const hit = data.lookup('8800570000224');  // {name, product, how} | null
 *   const r = await data.register('타이레놀', '8800570000224'); // {ok, action}
 *
 * 쓰기(register)는 워커가 Origin을 검사하므로, 허용된 도메인에서만 성공한다.
 * 전역 window.JaegoData 로 노출.
 * ============================================================ */
(function (global) {
  'use strict';

  // BarcodeUtils 없으면 최소 정규화로 폴백
  const U = global.BarcodeUtils || {
    normalize: (r) => String(r || '').replace(/[^0-9]/g, ''),
    variants: (r) => [String(r || '').replace(/[^0-9]/g, '')],
    tail: (r) => { const d = String(r || '').replace(/\D/g, ''); return d.length >= 12 ? d.slice(-10) : null; },
  };

  function create(opts) {
    opts = opts || {};
    const sheetUrl = (opts.sheetUrl || '').replace(/\/+$/, '');
    if (!sheetUrl) throw new Error('JaegoData: opts.sheetUrl 이 필요합니다');
    const cacheKey = opts.cacheKey || ('jaego_cache:' + sheetUrl);

    let products = [];
    try { products = JSON.parse(global.localStorage.getItem(cacheKey) || '[]'); } catch (e) {}
    let counter = 0;

    // ── JSONP GET (워커는 callback 지원) ──
    function jsonp(url) {
      return new Promise((resolve, reject) => {
        const cb = 'jd_cb_' + (counter++) + '_' + (products.length);
        const s = document.createElement('script');
        let done = false;
        const to = setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error('timeout')); }, 15000);
        function cleanup() { try { delete global[cb]; } catch (e) {} if (document.head.contains(s)) document.head.removeChild(s); clearTimeout(to); }
        global[cb] = (d) => { if (done) return; done = true; cleanup(); resolve(d); };
        s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
        s.onerror = () => { if (done) return; done = true; cleanup(); reject(new Error('network')); };
        document.head.appendChild(s);
      });
    }

    // ── 쓰기 POST (Origin 검사 통과 도메인에서만 성공) ──
    async function post(payload) {
      try {
        const res = await fetch(sheetUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow', body: JSON.stringify(payload) });
        const d = await res.json();
        return !!(d && d.success);
      } catch (e) { return false; }
    }

    // ── 전체 제품 로드 ──
    async function load() {
      const d = await jsonp(sheetUrl + '?action=getAll');
      if (d && d.success && Array.isArray(d.products)) {
        products = d.products;
        try { global.localStorage.setItem(cacheKey, JSON.stringify(products)); } catch (e) {}
      }
      return products;
    }

    // ── 조회: 직접 → 변형/별칭 → 뒷자리(이름 유일할 때만) ──
    function lookup(rawBarcode) {
      const norm = U.normalize(rawBarcode);
      const vs = U.variants(rawBarcode);
      for (const p of products) {
        if (!p.name) continue;
        const keys = [p.barcode, ...(p.extraBarcodes || [])].filter(Boolean).map(U.normalize);
        if (keys.includes(norm) || keys.some((k) => vs.includes(k))) return { name: p.name, product: p, how: 'direct' };
      }
      const t = U.tail(norm);
      if (t) {
        const hits = products.filter((p) => {
          if (!p.name) return false;
          const keys = [p.barcode, ...(p.extraBarcodes || [])].filter(Boolean);
          return keys.some((k) => U.tail(k) === t);
        });
        const uniq = [...new Set(hits.map((h) => h.name))];
        if (uniq.length === 1) return { name: uniq[0], product: hits[0], how: 'tail' };
      }
      return null;
    }

    // ── 이름만 있고 바코드 없는 품목(매칭 대상) ──
    function noBarcode() {
      return products.filter((p) => p.name && !(p.barcode && String(p.barcode).trim()));
    }

    // ── 제품명에 바코드 등록 (시트 반영) ──
    //   같은 이름 제품이 바코드 없음 → setMainBarcode / 있음 → addExtraBarcode
    async function register(name, rawBarcode) {
      const bc = U.normalize(rawBarcode);
      const sp = products.find((p) => p.name === name);
      if (!sp) return { ok: false, action: 'none', reason: 'not-in-sheet' };
      const mainBc = sp.barcode && String(sp.barcode).trim();
      if (!mainBc) {
        const ok = await post({ action: 'setMainBarcode', existingName: name, newBarcode: bc, rowIndex: sp.rowIndex });
        if (ok) sp.barcode = bc;
        if (ok) try { global.localStorage.setItem(cacheKey, JSON.stringify(products)); } catch (e) {}
        return { ok, action: 'setMainBarcode' };
      }
      if (U.normalize(mainBc) !== bc) {
        const ok = await post({ action: 'addExtraBarcode', existingBarcode: mainBc, newBarcode: bc });
        if (ok) { sp.extraBarcodes = sp.extraBarcodes || []; if (!sp.extraBarcodes.includes(bc)) sp.extraBarcodes.push(bc); try { global.localStorage.setItem(cacheKey, JSON.stringify(products)); } catch (e) {} }
        return { ok, action: 'addExtraBarcode' };
      }
      return { ok: true, action: 'already' };
    }

    return {
      load: load,
      lookup: lookup,
      register: register,
      noBarcode: noBarcode,
      get products() { return products; },
      get sheetUrl() { return sheetUrl; },
    };
  }

  global.JaegoData = { create: create };

})(typeof window !== 'undefined' ? window : this);
