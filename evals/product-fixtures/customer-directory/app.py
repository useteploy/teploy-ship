"""Disposable acceptance app: browser UI, HTTP API and SQLite persistence."""
import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

DB = os.environ.get('DIRECTORY_DB', 'directory.sqlite')

def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE)')
    return db

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/contacts':
            with connect() as db:
                self.reply(200, [dict(row) for row in db.execute('SELECT id, name, email FROM contacts ORDER BY id')])
        elif path == '/':
            body = Path(__file__).with_name('index.html').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/api/contacts':
            return self.reply(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length > 4096:
                return self.reply(413, {'error': 'Request too large'})
            data = json.loads(self.rfile.read(length))
            name = str(data.get('name', '')).strip()
            email = str(data.get('email', '')).strip()
            if not name or '@' not in email:
                return self.reply(400, {'error': 'Enter a name and a valid email'})
            with connect() as db:
                cursor = db.execute('INSERT INTO contacts(name,email) VALUES (?,?)', (name,email))
                self.reply(201, {'id': cursor.lastrowid, 'name':name, 'email':email})
        except (ValueError, sqlite3.IntegrityError):
            self.reply(400, {'error':'Invalid or duplicate contact'})

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('PORT','8080'))), Handler).serve_forever()
