const Main = imports.ui.main;

function computePanelPosition() {
  const invisible = { x: 0, y: 0, width: 0, height: 0 };
  if (Main.layoutManager.primaryIndex === -1) {
    return invisible;
  }

  const monitor = Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
  const panel = Main.panel;
  const isTop = panel.x === monitor.x && panel.width === monitor.width;
  const isRight = panel.x > monitor.x && panel.height === monitor.height;
  const isBottom = panel.y > monitor.y && panel.width === monitor.width;
  const isLeft = panel.x === monitor.x && panel.height === monitor.height;

  return {
    Top: isTop ? panel : invisible,
    Right: isRight ? panel : invisible,
    Bottom: isBottom ? panel : invisible,
    Left: isLeft ? panel : invisible
  };
}

var Panel = computePanelPosition();
