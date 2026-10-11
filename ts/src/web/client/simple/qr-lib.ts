// The pinned QR library. qr-sandbox.html repeats `url` and `integrity` as literals; a test
// keeps them equal to this object.
export const QR_LIB = {
  name: 'qrcode-generator',
  version: '1.4.4',
  license: 'MIT',
  sizeKb: 55,
  url: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  // Hash of package/qrcode.js in the npm tarball (verified against it, not only the CDN copy).
  integrity: 'sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k',
} as const;
