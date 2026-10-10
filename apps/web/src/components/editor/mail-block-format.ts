import { Extension } from '@tiptap/core';

/** Email-safe block styles; no classes or editor-only attributes in sent HTML. */
export const MailBlockFormat = Extension.create({
  name: 'mailBlockFormat',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) =>
              Math.min(
                5,
                Math.max(0, Math.round((parseInt(element.style.marginLeft, 10) || 0) / 32)),
              ),
            renderHTML: (attributes) =>
              attributes['indent']
                ? { style: `margin-left: ${Number(attributes['indent']) * 32}px` }
                : {},
          },
          textAlign: {
            default: 'left',
            parseHTML: (element) =>
              ['left', 'center', 'right'].includes(element.style.textAlign)
                ? element.style.textAlign
                : 'left',
            renderHTML: (attributes) =>
              attributes['textAlign'] !== 'left'
                ? { style: `text-align: ${String(attributes['textAlign'])}` }
                : {},
          },
          lineHeight: {
            default: '1.5',
            parseHTML: (element) =>
              ['1', '1.5', '2'].includes(element.style.lineHeight)
                ? element.style.lineHeight
                : '1.5',
            renderHTML: (attributes) =>
              attributes['lineHeight'] !== '1.5'
                ? { style: `line-height: ${String(attributes['lineHeight'])}` }
                : {},
          },
        },
      },
    ];
  },
});
