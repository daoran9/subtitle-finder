(function () {
  const win = window;
  const logger = {
    info: function () {
      console.info.apply(console, ["[SubtitleFinderBridge]"].concat(Array.prototype.slice.call(arguments)));
    },
  };

  /*
   * ================================================================================
   * 步骤1：补齐早期 Capacitor 事件桥
   * ================================================================================
   * 目标：
   * 1) 在 Android 原生层触发 resume/pause 事件前保证 window.Capacitor 存在
   * 2) 只补缺失方法，不覆盖 Capacitor 正式桥接对象
   */
  logger.info("开始补齐早期 Capacitor 事件桥...");

  // 1.1 保留原有 Capacitor 对象
  const capacitor = win.Capacitor || {};
  win.Capacitor = capacitor;

  // 1.2 补齐事件创建方法
  if (typeof capacitor.createEvent !== "function") {
    capacitor.createEvent = function (eventName, eventData) {
      const event = document.createEvent("Events");
      event.initEvent(eventName, false, false);
      const data = eventData || {};
      Object.keys(data).forEach(function (key) {
        event[key] = data[key];
      });
      return event;
    };
  }

  // 1.3 补齐事件触发方法
  if (typeof capacitor.triggerEvent !== "function") {
    capacitor.triggerEvent = function (eventName, target, eventData) {
      const event = capacitor.createEvent(eventName, eventData);
      if (target === "window") return win.dispatchEvent(event);
      if (target === "document") return document.dispatchEvent(event);
      const element = document.querySelector(target);
      return element ? element.dispatchEvent(event) : false;
    };
  }

  logger.info("补齐早期 Capacitor 事件桥完成");
})();
