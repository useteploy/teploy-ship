"""Basic verification command for the scratch static-site project."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        self.links.extend(value for key, value in attrs if key == "href" and value)


pages = sorted(Path(".").glob("*.html"))
assert {"index.html", "about.html"} <= {p.name for p in pages}, "missing site pages"
for path in pages:
    page = Page()
    page.feed(path.read_text())
    assert page.tags.count("title") == 1, f"{path}: expected one title"
    assert page.tags.count("h1") == 1, f"{path}: expected one heading"
    for link in page.links:
        url = urlsplit(link)
        if not url.scheme and not url.netloc and url.path:
            target = Path(unquote(url.path).lstrip("/"))
            assert target.is_file(), f"{path}: missing linked file {link}"
print(f"Verified {len(pages)} HTML pages and their local links")
