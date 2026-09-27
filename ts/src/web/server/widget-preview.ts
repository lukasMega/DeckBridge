// Size previews for the WebUI text-size picker: the widget's last painted lines
// re-laid at every text size in the paint's style. Lines don't depend on the size, so
// this matches what the device would show — including live command/plugin/weather text.
import { EXTRA_KEY_TEXT_SIZES } from '../../types.js';
import { layoutWidget, type WidgetPaint } from '../../widget-layout.js';
import { composeLayout } from '../../widget-raster.js';
import type { ExtraKeyPreview } from '../contract.js';

export function widgetPreviews({ lines, width, height, style }: WidgetPaint): ExtraKeyPreview[] {
  return EXTRA_KEY_TEXT_SIZES.map((textSize) => {
    const layout = layoutWidget(lines, width, height, { ...style, textSize });
    const data = Buffer.from(composeLayout(layout, width, height)).toString('base64');
    return { textSize, data, clipped: layout.clipped };
  });
}
