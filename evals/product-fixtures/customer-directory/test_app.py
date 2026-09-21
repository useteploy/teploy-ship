import json
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import app

class ContactsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app.DB = self.temp.name + '/contacts.sqlite'
        self.server = app.ThreadingHTTPServer(('127.0.0.1',0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()
    def create(self, name, email):
        return urlopen(Request(self.url+'/api/contacts',data=json.dumps({'name':name,'email':email}).encode(),headers={'Content-Type':'application/json'}))
    def test_create_and_persist(self):
        with self.create('Ada','ada@example.test') as response:
            self.assertEqual(response.status,201)
        with urlopen(self.url+'/api/contacts') as response:
            self.assertEqual(json.load(response)[0]['name'],'Ada')
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM contacts').fetchone()[0],1)
    def test_invalid_email(self):
        with self.assertRaises(HTTPError) as caught:
            self.create('Ada','invalid')
        self.assertEqual(caught.exception.code,400)
    def test_duplicate_email(self):
        self.create('Ada','ada@example.test').close()
        with self.assertRaises(HTTPError) as caught:
            self.create('Other','ada@example.test')
        self.assertEqual(caught.exception.code,400)
if __name__ == '__main__': unittest.main()
