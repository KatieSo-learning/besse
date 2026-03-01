function startGameClock(options) {
  const settings = options || {};
  const totalDays = Number.isInteger(settings.totalDays) ? settings.totalDays : 180;
  const startDay = Number.isInteger(settings.startDay) ? settings.startDay : 1;
  const tickSeconds = Number.isFinite(settings.tickSeconds) ? settings.tickSeconds : 10;
  const onTick = typeof settings.onTick === "function" ? settings.onTick : function () {};
  const onComplete = typeof settings.onComplete === "function" ? settings.onComplete : function () {};

  if (startDay < 1) {
    throw new Error("startDay must be >= 1");
  }
  if (totalDays < startDay) {
    throw new Error("totalDays must be >= startDay");
  }
  if (tickSeconds <= 0) {
    throw new Error("tickSeconds must be > 0");
  }

  let day = startDay;
  let timerId = null;
  let running = false;

  function stop() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    running = false;
  }

  function getState() {
    return { day, totalDays, tickSeconds, running };
  }

  function start() {
    if (running) {
      return getState();
    }
    running = true;
    onTick({ day, totalDays });

    timerId = setInterval(function () {
      if (day >= totalDays) {
        stop();
        onComplete({ day, totalDays });
        return;
      }

      day += 1;
      onTick({ day, totalDays });

      if (day >= totalDays) {
        stop();
        onComplete({ day, totalDays });
      }
    }, tickSeconds * 1000);

    return getState();
  }

  return { start, stop, getState };
}

module.exports = { startGameClock };
