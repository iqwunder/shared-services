# Gemeinsame Datenbank-Services

Dieses Node.js-Modul stellt die REST-APIs für Bücherei und MeterPulse in einem
Prozess bereit. Die bisherigen API-Routen bleiben unter `/api` erhalten. Die
Datenbankzugänge werden nur vom Service verwendet, nicht in den Frontends.

## Lokal starten

1. `.env.example` nach `.env` kopieren und beide Datenbank-URLs eintragen.
2. Im Ordner `services` ausführen:

   ```powershell
   npm.cmd ci
   npm.cmd start
   ```

Der Dienst lauscht standardmäßig unter `http://127.0.0.1:3000`. Die lokale
Health-Prüfung prüft beide Datenbankverbindungen:

```text
GET http://127.0.0.1:3000/api/health
```

In MeterPulse und Bücherei werden API-Aufrufe lokal durch den jeweiligen
Angular-Entwicklungsserver an Port 3000 weitergeleitet. Bücherei verwendet
standardmäßig Port 4300, MeterPulse Port 4200.

## Deployment

Der Jenkinsfile in diesem Ordner baut und deployed den gemeinsamen Service als
ein Paket nach `/opt/shared-services` auf den Datenbankserver. Das Paket enthält
seine Node-Abhängigkeiten und kann deshalb auf dem Zielserver ohne Internetzugriff
installiert werden.

Für Jenkins werden `NODEJS_24`, `DEPLOY_SSH_KEY`, `DATABASE_SERVER_IP` und die
Credentials `meterpulse-database-url` sowie `buecherei-database-url` benötigt.
Der Jenkins-Benutzer `jenkins-deploy` muss auf dem Zielserver für die im
Jenkinsfile verwendeten `sudo`- und systemd-Befehle passwortlos berechtigt sein.
Der Server muss Node.js unter `/usr/bin/node` bereitstellen.

Der Dienst bindet beim Deployment an `0.0.0.0:3000`, damit interne Clients ihn
erreichen können. Die Server-Firewall muss den Zugriff auf TCP-Port 3000 auf das
interne Netz beschränken; der Port darf nicht aus dem Internet erreichbar sein.
`CORS_ORIGINS` muss die Ursprünge der bereitgestellten Frontends enthalten.

Die Frontend-Jenkinsfiles benötigen bei einem Deployment den Parameter
`SERVICE_API_URL`, zum Beispiel `http://dbserver.intern:3000`. Dieser Wert wird
als Laufzeitkonfiguration in das jeweilige Frontend geschrieben; ein erneuter
Frontend-Build ist bei einer URL-Änderung nicht erforderlich.
