export function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), {
    href: url,
    download: name,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
