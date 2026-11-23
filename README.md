# Gemeinsame Datenbank-Services

Dieses Node.js-Modul stellt die REST-APIs für Bücherei, MeterPulse und Depotblick
in einem Prozess bereit. Die bisherigen API-Routen bleiben unter `/api`
erhalten. Die Datenbankzugänge werden nur vom Service verwendet, nicht in den
Frontends. Depotblick speichert Zugänge und aktive Sessions verschlüsselt in
einer eigenen Datenbank und stellt aktive Sessions nach einem Neustart wieder
her.

## Lokal starten

1. `.env.example` nach `.env` kopieren, alle drei Datenbank-URLs eintragen und
   für `DEPOTBLICK_SESSION_ENCRYPTION_KEY` einen stabilen 32-Byte-Schlüssel als
   64-stellige Hex-Zeichenfolge setzen (z. B. mit
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`).
   Die Depotblick-Datenbank muss vorher angelegt sein; der Datenbankbenutzer
   benötigt Rechte zum Erstellen, Lesen, Schreiben und Löschen der Sessiontabellen.
2. In diesem Ordner ausführen:

   ```powershell
   npm.cmd ci
   npm.cmd start
   ```

Der Dienst lauscht standardmäßig unter `http://127.0.0.1:3000`. Die lokale
Health-Prüfung prüft alle drei Datenbankverbindungen:

```text
GET http://127.0.0.1:3000/api/health
```

Die Depotblick-Routen (`/api/auth`, `/api/accounts`, `/api/instruments`,
`/api/portfolio` und `/api/depot`) werden vom selben Prozess bedient. API-Tests
für die comdirect-Anbindung laufen mit `npm.cmd run test:depotblick`.

In MeterPulse und Bücherei werden API-Aufrufe lokal durch den jeweiligen
Angular-Entwicklungsserver an Port 3000 weitergeleitet. Bücherei verwendet
standardmäßig Port 4300, MeterPulse Port 4200.

## Deployment

Der Jenkinsfile in diesem Ordner baut und deployed den gemeinsamen Service als
ein Paket nach `/opt/shared-services` auf den Datenbankserver. Dazu gehören auch
die Depotblick-API-Quellen und ihre Tests. Das Paket enthält
seine Node-Abhängigkeiten und kann deshalb auf dem Zielserver ohne Internetzugriff
installiert werden.

Für Jenkins werden `NODEJS_24`, `DEPLOY_SSH_KEY`, `SERVICE_HOST` und die
Credentials `meterpulse-database-url`, `buecherei-database-url`,
`depotblick-database-url` und `depotblick-session-encryption-key` benötigt.
Der Depotblick-Datenbankbenutzer benötigt Rechte zum Erstellen und Ändern der
beiden Depotblick-Tabellen. Der Verschlüsselungsschlüssel muss über Deployments
hinweg stabil bleiben; bei Verlust lassen sich gespeicherte Sessions nicht
wiederherstellen.
Der Jenkins-Benutzer `jenkins-deploy` muss auf dem Zielserver für die im
Jenkinsfile verwendeten `sudo`- und systemd-Befehle passwortlos berechtigt sein.
Der Server muss Node.js unter `/usr/bin/node` bereitstellen.

Der Dienst bindet beim Deployment an `0.0.0.0:3000`, damit interne Clients ihn
erreichen können. Die Server-Firewall muss den Zugriff auf TCP-Port 3000 auf das
interne Netz beschränken; der Port darf nicht aus dem Internet erreichbar sein.
`CORS_ORIGINS` muss die Ursprünge der bereitgestellten Frontends enthalten.

Die Frontend-Jenkinsfiles benötigen bei einem Deployment den Parameter
`SERVICE_API_URL`, zum Beispiel `http://dbserver.intern:3000`. Angular ruft die
API same-origin über `/api/` auf; der Nginx-Reverse-Proxy auf dem jeweiligen
Frontend-Server leitet den Aufruf an diese interne Service-URL weiter. Der
Service-Port muss daher vom Frontend-Server erreichbar sein, aber nicht direkt
aus dem Browser oder dem Internet.
