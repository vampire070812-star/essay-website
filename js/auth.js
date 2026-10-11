/* ============================================================
 * 账号客户端：登录 / 退出 / 当前会话
 *  - 会话由服务端 HttpOnly Cookie 维持，JS 读不到令牌本身
 *  - 云端历史报告、作文草稿、每日配额查询
 * 上海高考思辨议论文批改 · split33
 * ============================================================ */
(function (global) {
  'use strict';

  var me = null;                 // /api/auth/me 的完整返回
  var changeListeners = [];

  function emitChange() {
    changeListeners.forEach(function (fn) {
      try { fn(me); } catch (e) { /* 单个监听出错不影响其他 */ }
    });
  }

  function setMe(next) {
    me = next || null;
    emitChange();
  }

  function request(method, url, body) {
    var opt = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (resp) {
      return resp.json().catch(function () { return null; }).then(function (data) {
        if (resp.ok && data && data.ok) return data;
        var err = new Error((data && data.message) || ('服务异常（HTTP ' + resp.status + '）'));
        err.code = (data && data.code) || ('http_' + resp.status);
        err.status = resp.status;
        err.data = data;
        throw err;
      });
    });
  }

  /* ---------------- 会话 ---------------- */

  function refreshMe() {
    return request('GET', '/api/auth/me').then(function (d) {
      setMe(d);
      return d;
    }).catch(function () {
      setMe({ user: null });
      return { user: null };
    });
  }

  function login(loginName, password) {
    return request('POST', '/api/auth/login', { login: loginName, password: password })
      .then(function (d) { setMe(d); return d; });
  }

  function logout() {
    return request('POST', '/api/auth/logout', {}).then(function () {
      setMe({ user: null });
    }).catch(function () {
      setMe({ user: null });
    });
  }

  /* ---------------- 会话缓存（刷新时先即时显示） ---------------- */

  // 用浏览器本地缓存的上次会话信息即时填充（刷新页面时先显示已登录，
  // 再由 refreshMe() 与服务端核对；服务端确认已退出则立即改回未登录）
  function hydrate(cached) {
    if (cached && cached.user) {
      me = cached;
      emitChange();
    }
  }

  function user() { return me && me.user ? me.user : null; }
  function quota() { return me && me.quota ? me.quota : null; }

  function onChange(fn) {
    changeListeners.push(fn);
  }

  function listEssays() {
    return request('GET', '/api/essays').then(function (d) { return d.essays || []; });
  }

  function getEssay(id) {
    return request('GET', '/api/essays/' + encodeURIComponent(id)).then(function (d) {
      return d.essay;
    });
  }

  function saveEssay(payload) {
    return request('POST', '/api/essays', payload).then(function (d) { return d; });
  }

  function deleteEssay(id) {
    return request('DELETE', '/api/essays/' + encodeURIComponent(id));
  }

  /* ---------------- 草稿 ---------------- */

  function loadDraft() {
    return request('GET', '/api/draft').then(function (d) { return d.draft; });
  }

  function saveDraft(draft) {
    return request('POST', '/api/draft', { draft: draft });
  }

  function clearDraft() {
    return request('POST', '/api/draft', { draft: null }).catch(function () { /* 静默 */ });
  }

  global.EssayAuth = {
    hydrate: hydrate,
    refreshMe: refreshMe,
    login: login,
    logout: logout,
    user: user,
    quota: quota,
    onChange: onChange,
    listEssays: listEssays,
    getEssay: getEssay,
    saveEssay: saveEssay,
    deleteEssay: deleteEssay,
    loadDraft: loadDraft,
    saveDraft: saveDraft,
    clearDraft: clearDraft
  };
})(window);
