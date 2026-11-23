pipeline {
    agent any

    tools {
        nodejs 'NODEJS_24'
    }

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    parameters {
        booleanParam(name: 'DEPLOY', defaultValue: false, description: 'Soll der gemeinsame Service deployed werden?')
        string(name: 'CORS_ORIGINS', defaultValue: '', description: 'Kommagetrennte Frontend-Ursprünge')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install and check') {
            steps {
                sh '''
                    set -eu
                    npm ci
                    npm run check
                    npm prune --omit=dev
                    tar -czf services.tar.gz server package.json package-lock.json node_modules
                '''
            }
        }

        stage('Deploy') {
            when {
                expression { params.DEPLOY }
            }
            steps {
                sshagent(credentials: ["${DEPLOY_SSH_KEY}"]) {
                    withCredentials([
                        string(credentialsId: 'meterpulse-database-url', variable: 'METERPULSE_DATABASE_URL'),
                        string(credentialsId: 'buecherei-database-url', variable: 'BUECHEREI_DATABASE_URL')
                    ]) {
                        sh '''
                            set +x
                            set -eu
                            : "${DATABASE_SERVER_IP:?DATABASE_SERVER_IP muss gesetzt sein}"
                            : "${CORS_ORIGINS:?CORS_ORIGINS muss gesetzt sein}"
                            : "${METERPULSE_DATABASE_URL:?Das MeterPulse-Datenbank-Credential ist leer}"
                            : "${BUECHEREI_DATABASE_URL:?Das Bücherei-Datenbank-Credential ist leer}"

                            ssh_options="-o BatchMode=yes -o StrictHostKeyChecking=yes"
                            service_env=$(mktemp)
                            trap 'rm -f "$service_env"' EXIT
                            umask 077
                            {
                                printf 'API_HOST=0.0.0.0\\n'
                                printf 'API_PORT=3000\\n'
                                printf 'DATABASE_URL=%s\\n' "$METERPULSE_DATABASE_URL"
                                printf 'BUECHEREI_DATABASE_URL=%s\\n' "$BUECHEREI_DATABASE_URL"
                                printf 'CORS_ORIGIN=%s\\n' "$CORS_ORIGINS"
                            } > "$service_env"

                            scp $ssh_options services.tar.gz "jenkins-deploy@${SERVICE_HOST}:/tmp/shared-services-${BUILD_NUMBER}.tar.gz"
                            scp $ssh_options "$service_env" "jenkins-deploy@${SERVICE_HOST}:/tmp/shared-services-${BUILD_NUMBER}.env"
                            ssh $ssh_options "jenkins-deploy@${SERVICE_HOST}" "bash -s -- '$BUILD_NUMBER'" <<'REMOTE'
                    set -eu
                    build_number="$1"
                    archive="/tmp/shared-services-${build_number}.tar.gz"
                    service_env="/tmp/shared-services-${build_number}.env"
                    trap 'rm -f "$archive" "$service_env"' EXIT
                    sudo -n id shared-services >/dev/null 2>&1 || sudo -n useradd --system --no-create-home --shell /usr/sbin/nologin shared-services
                    sudo -n mkdir -p /opt/shared-services
                    sudo -n tar -xzf "$archive" -C /opt/shared-services
                    sudo -n install -o shared-services -g shared-services -m 600 "$service_env" /opt/shared-services/.env
                    sudo -n chown -R shared-services:shared-services /opt/shared-services
                    sudo -n install -m 644 /opt/shared-services/server/shared-services.service /etc/systemd/system/shared-services.service
                    sudo -n systemctl daemon-reload
                    sudo -n systemctl enable shared-services
                    sudo -n systemctl restart shared-services
                    curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/api/health
REMOTE
                        '''
                    }
                }
            }
        }
    }

    post {
        always {
            sh 'rm -f services.tar.gz'
        }
    }
}
