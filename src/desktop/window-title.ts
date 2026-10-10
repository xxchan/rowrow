// A server window's title: the page's own ("rowrow", or "rowrow · Work" with a title suffix),
// and the server's name beside it only when this app has several servers, as notifications do.

export function windowTitle(page: string, serverName: string, several: boolean): string {
  const title = page.trim() === "" ? "rowrow" : page;
  if (!several || title.includes(serverName)) return title;
  return `${title} — ${serverName}`;
}
