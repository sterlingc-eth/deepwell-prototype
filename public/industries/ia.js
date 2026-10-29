/* Industry hero stage runtime: starts when visible, pauses off-screen or on request, loops twice then rests on the final frame. */
(function () {
  var s = document.querySelector('.ia-stage');
  if (!s) return;
  s.__ia = 1;
  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  var btn = s.querySelector('.ia-pb');
  var PERIOD = 13500, MAX = 2, loops = 0, el = 0, last = 0, vis = false, user = false, timer = 0, io;
  function stop() { clearInterval(timer); timer = 0; s.classList.remove('ia-arm', 'ia-go', 'ia-paused', 'ia-fo'); }
  function sync() {
    var on = vis && !user && !document.hidden;
    s.classList.toggle('ia-paused', !on);
    if (on && s.classList.contains('ia-go') && loops < MAX && !timer) { last = performance.now(); timer = setInterval(tick, 250); }
    if (!on && timer) { clearInterval(timer); timer = 0; }
  }
  function tick() {
    var n = performance.now(); el += n - last; last = n;
    if (el < PERIOD) return;
    clearInterval(timer); timer = 0;
    if (loops >= MAX) return;
    loops++;
    s.classList.add('ia-fo');
    setTimeout(function () {
      s.classList.remove('ia-arm'); void s.offsetWidth; s.classList.add('ia-arm'); s.classList.remove('ia-fo');
      el = 0; sync();
    }, 520);
  }
  function arm() {
    if (mq.matches || !('IntersectionObserver' in window)) { stop(); if (io) io.disconnect(); return; }
    s.classList.add('ia-arm');
    if (!io) {
      io = new IntersectionObserver(function (es) {
        vis = es[0].isIntersecting;
        if (vis && !s.classList.contains('ia-go')) { s.classList.add('ia-go'); }
        sync();
      }, { threshold: 0.35 });
      io.observe(s);
    }
  }
  if (btn) btn.addEventListener('click', function () {
    user = !user;
    btn.setAttribute('aria-pressed', user ? 'true' : 'false');
    btn.textContent = user ? 'Play' : 'Pause';
    btn.setAttribute('aria-label', user ? 'Play the animation' : 'Pause the animation');
    sync();
  });
  document.addEventListener('visibilitychange', sync);
  var onMq = function () { if (mq.matches) { stop(); } else { arm(); } };
  if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  arm();
})();
