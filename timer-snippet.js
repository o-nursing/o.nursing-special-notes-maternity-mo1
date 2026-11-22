/**
 * O.Nursing — Module 1 Timed Quiz: timer + server submit (injection snippet)
 * ============================================================================
 * WHAT IT IS
 *   A self-contained add-on for the Module 1 quiz page. It adds ONLY:
 *   (1) a required Name field on the home screen (no Start without a name),
 *   (2) a 30:00 countdown that starts when the student presses Start,
 *   (3) submit of name + score + answers to the Apps Script web app,
 *   (4) the close-and-reopen rule: the start time lives on the SERVER and
 *       in localStorage, so closing the page and coming back keeps counting
 *       from the original start, and locks the quiz when time ends.
 *
 *   It does NOT touch the existing quiz scoring, Hint/explanation,
 *   flashcards, or the Special O.Nursing Questions sections.
 *
 * HOW TO INJECT (during the page redesign)
 *   Add this ONE line immediately before </body>, AFTER the page's own
 *   <script> block (this snippet must run after the page script, because
 *   it wraps the page's startQuiz/finishAnswer globals):
 *       <script src="timer-snippet.js"></script>
 *   Then set WEB_APP_URL below to the deployed web-app /exec URL.
 *   (If the URL is still the placeholder, the local timer still works,
 *   but nothing is sent to the Sheet — the results screen says so.)
 *
 * PAGE HOOKS THIS SNIPPET DEPENDS ON (verified against the current page;
 * if the redesign renames them, update the names in the CONFIG section):
 *   Element IDs: home, levels, btn-start, btn-resume, home-stats,
 *   quiz, prog-fill, q-count, q-badge, q-score, q-stem, q-body,
 *   btn-hint, q-hint, q-explain, q-model, btn-next, btn-finish,
 *   results, res-pct, res-line, res-table, btn-retry, btn-home,
 *   flashcards, special.
 *   Page globals (same global scope, classic scripts): QUESTIONS
 *   [{id, level, type, q, options, correct, hint, explain, model}],
 *   selectedLvl, queue, idx, score, answered, results,
 *   startQuiz(resume), finishAnswer(ok), renderQ(), cur(), showResults().
 *   Notes: btn-start/btn-resume/btn-retry call startQuiz() BY NAME, so
 *   wrapping the startQuiz binding intercepts them. btn-finish was given
 *   the showResults function OBJECT at registration, so it is NOT
 *   intercepted by wrapping — this snippet instead adds its own later
 *   click listener on #btn-finish (listeners run in registration order,
 *   so the page's showResults runs first, then the submit).
 *
 * SERVER CONTRACT (Code.gs in this folder)
 *   POST {action:'start', name}            -> {ok, name, startedAt}
 *   POST {action:'submit', name, startedAt, answers, score, total,
 *         timeTakenSec}                    -> {ok, name, status, elapsedSec, row}
 *   First start wins server-side; submit is validated against the
 *   SERVER-recorded start; late submits are stored flagged "late".
 *   POSTs use Content-Type: text/plain (lets the static GitHub page
 *   POST cross-origin to the Apps Script web app).
 */
(function () {
  'use strict';

  /* ================= CONFIG ================= */
  var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzGZRZjezTXjwqchPwX75dvE25Z-0pSnm8tBECz6pLLo6VwuOpUNHHnccguTJm0WAJ-cg/exec'; // deployed 2026-11-22 23:09 EET, Version 1
  var TIME_LIMIT_MS = 30 * 60 * 1000;          // 30 minutes per student
  var TKEY = 'onursing_m1_timed_v1';           // localStorage session key (this module only)
  var TOTAL = 30;                              // full timed attempt = all 30 scored questions

  /* ================= helpers ================= */
  function $(id) { return document.getElementById(id); }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(TKEY)) || null; } catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(TKEY, JSON.stringify(s)); } catch (e) {}
  }
  function endpointReady() {
    return WEB_APP_URL && WEB_APP_URL.indexOf('http') === 0 && WEB_APP_URL.indexOf('PASTE_THE_EXEC_URL') === -1;
  }
  function postJSON(payload) {
    if (!endpointReady()) return Promise.reject(new Error('endpoint not configured'));
    return fetch(WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }
  function fmt(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? '0' + m : '' + m) + ':' + (ss < 10 ? '0' + ss : '' + ss);
  }
  function esc(s) {
    var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML;
  }

  /* ================= session state ================= */
  var timerId = null;
  var submitInFlight = false;

  function readName() {
    var inp = $('tq-name');
    return inp ? inp.value.replace(/\s+/g, ' ').trim() : '';
  }

  /** Compact per-question result string, e.g. "M4:C M7:W M9:U ..." */
  function compactAnswers(s) {
    var qs = (typeof queue !== 'undefined' && queue && queue.length)
      ? queue
      : QUESTIONS.filter(function (q) { return q.type !== 'written'; });
    return qs.map(function (q) {
      var v = s.answers[q.id];
      return q.id + ':' + (v === true ? 'C' : v === false ? 'W' : 'U');
    }).join(' ');
  }

  /* ================= UI injection ================= */
  function injectStyles() {
    if ($('tq-style')) return;
    var st = document.createElement('style');
    st.id = 'tq-style';
    st.textContent =
      '#tq-name{width:100%;border:1.5px solid #e5d5c8;border-radius:12px;padding:12px 14px;' +
      'font-family:inherit;font-size:16px;margin-top:14px;direction:rtl;text-align:right;background:#fff;color:inherit}' +
      '#tq-name:focus{outline:2px solid var(--gold,#C9A227)}' +
      '#tq-bar{display:none;background:var(--gold-l,#F5ECD7);border:1.5px solid var(--gold,#C9A227);' +
      'border-radius:12px;padding:10px 14px;margin-top:14px;font-weight:800;font-size:16px;text-align:center}' +
      '#tq-bar.show{display:block}' +
      '#tq-bar.urgent{background:#fdecea;border-color:#b3261e;color:#b3261e}' +
      '#tq-note{font-size:13.5px;color:#8a7a72;text-align:center;margin-top:10px;line-height:1.8}' +
      '#tq-note b{color:var(--burg,#7C2D3E)}' +
      '#tq-timeup h1{color:#b3261e}' +
      '#tq-sent{margin-top:12px;font-size:14.5px;font-weight:700;line-height:1.9}' +
      '#tq-sent.ok{color:#2e7d4f}#tq-sent.no{color:#b3261e}';
    document.head.appendChild(st);
  }

  function injectNameField() {
    if ($('tq-name')) return;
    var startBtn = $('btn-start');
    if (!startBtn) return;
    var label = document.createElement('label');
    label.setAttribute('for', 'tq-name');
    label.style.cssText = 'display:block;margin-top:14px;font-weight:700;font-size:15px';
    label.textContent = 'الاسم (مطلوب قبل بدء الاختبار الموقوت)';
    var inp = document.createElement('input');
    inp.id = 'tq-name';
    inp.type = 'text';
    inp.placeholder = 'اكتب اسمك هنا…';
    inp.autocomplete = 'off';
    inp.maxLength = 100;
    startBtn.parentNode.insertBefore(label, startBtn);
    startBtn.parentNode.insertBefore(inp, startBtn);
    var note = document.createElement('div');
    note.id = 'tq-note';
    note.innerHTML = 'اختبار موقوت: <b>30 دقيقة</b> من لحظة الضغط على «ابدأ الأسئلة». ' +
      'لو قفلت الصفحة ودخلت تاني، الوقت بيكمل من مطرح ما وقف — ولما يخلص بيتقفل ويتبعت اللي جاوبته.';
    startBtn.parentNode.insertBefore(note, startBtn);
  }

  function injectTimerBar() {
    if ($('tq-bar')) return;
    var quiz = $('quiz');
    if (!quiz) return;
    var bar = document.createElement('div');
    bar.id = 'tq-bar';
    quiz.insertBefore(bar, quiz.firstChild);
  }

  function injectTimeUpCard() {
    if ($('tq-timeup')) return;
    var wrap = document.querySelector('.wrap');
    if (!wrap) return;
    var card = document.createElement('div');
    card.id = 'tq-timeup';
    card.className = 'card hidden';
    card.style.textAlign = 'center';
    card.innerHTML =
      '<h1>انتهى الوقت ⏰</h1>' +
      '<p style="margin-top:12px;font-size:15px;line-height:2" id="tq-timeup-line"></p>' +
      '<p style="margin-top:8px;font-size:14px;line-height:1.9" id="tq-timeup-sent"></p>' +
      '<button class="btn ghost hidden" id="tq-retry-send">إعادة إرسال الإجابات</button>';
    wrap.appendChild(card);
    $('tq-retry-send').addEventListener('click', function () { submitSession('timeout'); });
  }

  function setHomeNote(html) {
    var n = $('tq-note');
    if (n) n.innerHTML = html;
  }

  function noteAlreadySubmitted(s) {
    var msg = 'أرسلتَ محاولتك الموقوتة بالفعل (' + esc(s.name) + ' — ' + s.score + ' / ' + TOTAL +
      '). بطاقات المراجعة وأسئلة Special O.Nursing تحت لسه متاحة للمذاكرة.';
    setHomeNote(msg);
    // if the student is looking at the results screen (e.g. pressed retry),
    // the note must be visible there too, not only on the hidden home card.
    if ($('results') && !$('results').classList.contains('hidden')) {
      var div = $('tq-sent');
      if (!div) {
        div = document.createElement('div');
        div.id = 'tq-sent';
        var res = $('res-line');
        if (res) res.parentNode.insertBefore(div, res.nextSibling);
      }
      if (div) {
        div.className = '';
        div.textContent = msg.replace(/<[^>]*>/g, '');
      }
    }
  }

  /* ================= countdown ================= */
  function updateBar(s) {
    var bar = $('tq-bar');
    if (!bar) return;
    var remaining = TIME_LIMIT_MS - (Date.now() - s.startedAt);
    bar.classList.add('show');
    bar.classList.toggle('urgent', remaining <= 5 * 60 * 1000);
    bar.textContent = '⏱ ' + s.name + ' — الوقت المتبقي: ' + fmt(remaining); // textContent: no escaping needed
  }

  function startCountdown(s) {
    stopCountdown();
    updateBar(s);
    timerId = setInterval(function () {
      var sess = loadSession();
      if (!sess || sess.submitted) { stopCountdown(); return; }
      var remaining = TIME_LIMIT_MS - (Date.now() - sess.startedAt);
      if (remaining <= 0) { expireSession(); return; }
      updateBar(sess);
      var n = $('tq-note');
      if (n && sess && !$('home').classList.contains('hidden')) {
        n.innerHTML = 'محاولتك الموقوتة شغالة — المتبقي: <b>' + fmt(remaining) + '</b>. اضغط «ابدأ الأسئلة» للمتابعة.';
      }
    }, 1000);
  }

  function stopCountdown() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  /* ================= submit ================= */
  function submitSession(reason) {
    var s = loadSession();
    if (!s || s.submitted || submitInFlight) return;
    submitInFlight = true;
    var payload = {
      action: 'submit',
      name: s.name,
      startedAt: s.startedAt,
      answers: compactAnswers(s),
      score: s.score,
      total: TOTAL,
      timeTakenSec: Math.round((Date.now() - s.startedAt) / 1000)
    };
    function markSent(ok, msg) {
      submitInFlight = false;
      if (ok) {
        s.submitted = true;
        saveSession(s);
        stopCountdown();
      }
      showSentNote(ok, msg, s);
    }
    if (!endpointReady()) {
      markSent(false, 'الرابط بتاع السيرفر لسه متظبطش — إجاباتك محفوظة على جهازك بس، وموصلتش للشيت.');
      return;
    }
    postJSON(payload).then(function (res) {
      if (res && res.ok) {
        // messages below are rendered via textContent only, so the raw name is safe
        markSent(true, '✓ تم إرسال إجاباتك — الاسم: ' + s.name + ' • الدرجة: ' + s.score + ' / ' + TOTAL +
          ' • الحالة: ' + (res.status === 'late' ? 'متأخر (بعد الوقت)' : 'في الوقت'));
      } else {
        markSent(false, 'تعذّر الإرسال (' + ((res && res.error) || 'خطأ غير معروف') + ') — إجاباتك محفوظة على جهازك، جرّب تاني.');
      }
    }).catch(function () {
      // one retry after 3s, then report the failure (answers stay in localStorage)
      setTimeout(function () {
        postJSON(payload).then(function (res) {
          if (res && res.ok) {
            markSent(true, '✓ تم إرسال إجاباتك — الاسم: ' + s.name + ' • الدرجة: ' + s.score + ' / ' + TOTAL +
              ' • الحالة: ' + (res.status === 'late' ? 'متأخر (بعد الوقت)' : 'في الوقت'));
          } else {
            markSent(false, 'تعذّر الإرسال — إجاباتك محفوظة على جهازك، جرّب تاني من زر «إعادة إرسال الإجابات».');
          }
        }).catch(function () {
          markSent(false, 'تعذّر الإرسال (مشكلة اتصال) — إجاباتك محفوظة على جهازك، جرّب تاني من زر «إعادة إرسال الإجابات».');
        });
      }, 3000);
    });
  }

  function showSentNote(ok, msg, s) {
    var line = $('tq-timeup-sent');
    if (line && !$('tq-timeup').classList.contains('hidden')) {
      line.textContent = msg.replace(/<[^>]*>/g, '');
      $('tq-retry-send').classList.toggle('hidden', ok);
    }
    var res = $('res-line');
    if (res && !$('results').classList.contains('hidden')) {
      var div = $('tq-sent');
      if (!div) {
        div = document.createElement('div');
        div.id = 'tq-sent';
        res.parentNode.insertBefore(div, res.nextSibling);
      }
      div.className = ok ? 'ok' : 'no';
      div.textContent = msg.replace(/<[^>]*>/g, '');
    }
  }

  /* ================= expiry / lock ================= */
  function expireSession() {
    var s = loadSession();
    if (!s || s.submitted) return;
    stopCountdown();
    // lock the quiz UI and show the time's-up card FIRST, so the async
    // submit confirmation below has a visible place to land in.
    document.querySelectorAll('#q-body .opt').forEach(function (b) { b.disabled = true; });
    if ($('btn-next')) $('btn-next').classList.add('hidden');
    if ($('btn-finish')) $('btn-finish').classList.add('hidden');
    if ($('quiz')) $('quiz').classList.add('hidden');
    if ($('home')) $('home').classList.add('hidden');
    if ($('results')) $('results').classList.add('hidden');
    var line = $('tq-timeup-line');
    if (line) {
      line.innerHTML = 'خلصت الـ 30 دقيقة، ' + esc(s.name) + '.<br>جاوبت صح على <b>' +
        s.score + '</b> من <b>' + TOTAL + '</b> سؤال.';
    }
    if ($('tq-timeup')) $('tq-timeup').classList.remove('hidden');
    var btn = $('tq-retry-send');
    if (btn) btn.classList.add('hidden'); // shown only if the send actually fails
    if ($('tq-timeup')) $('tq-timeup').scrollIntoView();
    submitSession('timeout');
  }

  /* ================= quiz wrapping ================= */
  function setLevelAll() {
    try { selectedLvl = 'all'; } catch (e) {}
    document.querySelectorAll('#levels .lvl').forEach(function (x) {
      x.classList.toggle('on', x.dataset.lvl === 'all');
    });
  }

  function restoreTimedProgress(s) {
    try {
      score = s.score || 0;
      answered = s.answered || 0;
      results = Object.keys(s.answers || {}).map(function (id) {
        return { id: id, ok: !!s.answers[id] };
      });
      var firstOpen = queue.findIndex(function (q) { return !(q.id in (s.answers || {})); });
      if (firstOpen === -1) {
        showResults();
        submitSession('finish');
        return;
      }
      idx = firstOpen;
      renderQ();
      var qs = $('q-score');
      if (qs) qs.textContent = 'صح: ' + score + ' / ' + answered;
    } catch (e) {}
  }

  var _startQuiz = null;
  var _finishAnswer = null;

  function wrapPageFunctions() {
    if (typeof startQuiz === 'function' && !_startQuiz) {
      _startQuiz = startQuiz;
      startQuiz = function (resume) {
        var s = loadSession();
        if (s && s.submitted) {
          noteAlreadySubmitted(s);
          return;
        }
        if (s && !s.submitted) {
          var remaining = TIME_LIMIT_MS - (Date.now() - s.startedAt);
          if (remaining <= 0) { expireSession(); return; }
          _startQuiz(false); // fresh full queue, then jump to first unanswered
          restoreTimedProgress(s);
          startCountdown(s);
          return;
        }
        // no session yet: name is required, then start the server clock
        var name = readName();
        if (!name) {
          setHomeNote('اكتب <b>اسمك</b> الأول فوق زر «ابدأ الأسئلة» — الاختبار الموقوت محتاج الاسم عشان الحضور.');
          var inp = $('tq-name');
          if (inp) inp.focus();
          return;
        }
        setLevelAll(); // timed attempt always runs the full 30 questions
        var btn = $('btn-start');
        if (btn) { btn.disabled = true; btn.textContent = 'جارٍ بدء الوقت…'; }
        postJSON({ action: 'start', name: name }).then(function (res) {
          var startedAt = (res && res.startedAt) ? res.startedAt : Date.now();
          var sess = {
            name: name, startedAt: startedAt, submitted: false,
            answers: {}, score: 0, answered: 0, total: TOTAL,
            startUnconfirmed: !(res && res.ok)
          };
          saveSession(sess);
          if (btn) { btn.disabled = false; btn.textContent = 'ابدأ الأسئلة ←'; }
          _startQuiz(false);
          startCountdown(sess);
        }).catch(function () {
          // endpoint unreachable: keep going on the local clock; the server
          // will validate on submit against the client-sent startedAt.
          var startedAt = Date.now();
          var sess = {
            name: name, startedAt: startedAt, submitted: false,
            answers: {}, score: 0, answered: 0, total: TOTAL, startUnconfirmed: true
          };
          saveSession(sess);
          if (btn) { btn.disabled = false; btn.textContent = 'ابدأ الأسئلة ←'; }
          _startQuiz(false);
          startCountdown(sess);
        });
      };
    }
    if (typeof finishAnswer === 'function' && !_finishAnswer) {
      _finishAnswer = finishAnswer;
      finishAnswer = function (ok) {
        _finishAnswer(ok);
        try {
          var s = loadSession();
          if (s && !s.submitted) {
            var q = cur();
            if (q) s.answers[q.id] = !!ok;
            s.score = score;
            s.answered = answered;
            saveSession(s);
          }
        } catch (e) {}
      };
    }
  }

  /* ================= init ================= */
  function init() {
    if (typeof QUESTIONS === 'undefined' || !$('btn-start')) return; // page not ready / redesigned IDs
    injectStyles();
    injectNameField();
    injectTimerBar();
    injectTimeUpCard();
    wrapPageFunctions();

    // btn-finish was bound to the showResults OBJECT at registration, so a
    // later listener runs after the page's own showResults: submit then.
    var bf = $('btn-finish');
    if (bf) {
      bf.addEventListener('click', function () {
        var s = loadSession();
        if (s && !s.submitted) submitSession('finish');
      });
    }

    var s = loadSession();
    if (!s) return;
    var inp = $('tq-name');
    if (inp) { inp.value = s.name; inp.disabled = true; }
    if (s.submitted) {
      var bs = $('btn-start'), br = $('btn-resume');
      if (bs) bs.disabled = true;
      if (br) br.classList.add('hidden');
      noteAlreadySubmitted(s);
      return;
    }
    var remaining = TIME_LIMIT_MS - (Date.now() - s.startedAt);
    if (remaining <= 0) {
      expireSession();
      return;
    }
    var br2 = $('btn-resume');
    if (br2) { br2.classList.remove('hidden'); br2.textContent = 'كمّل المحاولة الموقوتة'; }
    setHomeNote('عندك محاولة موقوتة شغالة — المتبقي: <b>' + fmt(remaining) + '</b>. اضغط «ابدأ الأسئلة» للمتابعة من مطرح ما وقفت.');
    startCountdown(s); // keeps counting even while on the home screen
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
