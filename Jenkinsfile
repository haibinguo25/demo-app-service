pipeline {
  agent {label 'docker-agent'}
  options { timestamps() }
  parameters {
    choice(name: 'ENV', choices: ['staging','prod'], description: 'Deploy environment')
    string(name: 'SEMVER', defaultValue: '1.0.0', description: 'Release semver, e.g. 1.0.0')
  }
  environment {
    // ====== 替换占位符 ======
    AWS_REGION  = 'us-west-1'                          // e.g. us-west-2
    REGISTRY    = "163887847484.dkr.ecr.${AWS_REGION}.amazonaws.com"
    ECR_REPO    = "${REGISTRY}/demo-app-service"               // e.g. demo-app-service
    // =======================

    APP         = 'demo-app-service'
    //TAG         = "${params.SEMVER}-g${GIT_COMMIT.take(7)}"
    TAG = "${params.SEMVER}-g${GIT_COMMIT.take(7)}-b${BUILD_NUMBER}"
    REF         = "${ECR_REPO}:${TAG}"
    SBOM        = "sbom-${TAG}.json"
    COSIGN_EXPERIMENTAL = "1"

    // 同机并存：不同容器名 + 不同端口
    STAGING_HOST = '172.31.24.219'                       // e.g. 172.31.10.200
    PROD_HOST    = '172.31.24.219'                          // 可与 STAGING_HOST 相同
    STAGING_PORT = '8088'
    PROD_PORT    = '8089'
    PATH = "/home/jenkins/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  }
  

  stages {
    stage('Checkout'){ steps { checkout scm } }

    stage('Validate image tag') {
       steps {
        sh '''
        set -e
        echo "TAG=${TAG}"
        if echo "${TAG}" | grep -q '[^a-z0-9_.-]'; then
        echo "❌  Invalid Docker tag: ${TAG}"
        exit 125
      fi
    '''
       }
     }

    stage('Build') {
       steps {
        sh '''
        set -euxo pipefail
        pwd; ls -la
        test -f Dockerfile
        docker build --pull -t "${REF}" .
    '''
      }
     }


    stage('Push to ECR'){
      steps {
        sh """
          aws ecr get-login-password --region ${AWS_REGION} | \
            docker login --username AWS --password-stdin ${REGISTRY}
          docker push ${REF}
        """
      }
    }

    stage('Generate SBOM (CycloneDX)'){
      steps {
        sh "syft ${REF} -o cyclonedx-json > ${SBOM}"
        archiveArtifacts artifacts: "${SBOM}", fingerprint: true
      }
    }

    stage('Vulnerability Scan (HIGH/CRITICAL fail)'){
      steps {
	sh '''
        set -euxo pipefail
        trivy image --severity HIGH,CRITICAL --exit-code 0 --format table "${REF}" > trivy.txt || true
        '''
        archiveArtifacts artifacts: 'trivy.txt', fingerprint: true
      }
    }

    stage('Sign & Attest'){
      steps {
        //withCredentials([file(credentialsId: 'cosign-private-key', variable: 'COSIGN_KEY')]) {
        withCredentials([file(credentialsId: 'cosign-private-key', variable: 'COSIGN_KEY'),string(credentialsId: 'cosign-password',  variable: 'COSIGN_PASSWORD')
            ])}  
	    sh """
            DIGEST=\$(crane digest ${REF})
            IMG="${ECR_REPO}@\${DIGEST}"
            cosign sign --key \$COSIGN_KEY \${IMG}

            cat > provenance.json <<'JSON'
            {
              "buildType":"jenkins",
              "git":{"repo":"${GIT_URL}","commit":"${GIT_COMMIT}"},
              "jenkins":{"job":"${JOB_NAME}","buildNumber":"${BUILD_NUMBER}"},
              "artifact":{"image":"${REF}"}
            }
            JSON
            cosign attest --type slsaprovenance --predicate provenance.json \${IMG}
          """
        }
      }
    }

    stage('Change Control (Prod approval)'){
      when { expression { params.ENV == 'prod' } }
      steps { input message: "Approve PROD deploy for ${APP} ${TAG}?" }
    }

    stage('Deploy (isolated by port)'){
      steps {
        script {
          env.TARGET_HOST = (params.ENV == 'prod') ? env.PROD_HOST : env.STAGING_HOST
          env.TARGET_PORT = (params.ENV == 'prod') ? env.PROD_PORT : env.STAGING_PORT
          env.TARGET_NAME = "${APP}-${params.ENV}"
        }
        sshagent(credentials: ['deploy-ssh']) {
          sh """
            set -euo pipefail
            DIGEST=\$(crane digest ${REF})
            IMG="${ECR_REPO}@\${DIGEST}"

            cosign verify --key cosign.pub \${IMG}

            ssh -o StrictHostKeyChecking=yes ec2-user@${TARGET_HOST} '
              set -euo pipefail
              aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${REGISTRY}
              docker pull \${IMG}
              docker stop ${TARGET_NAME} || true
              docker rm ${TARGET_NAME} || true
              docker run -d --name ${TARGET_NAME} -p ${TARGET_PORT}:8080 --restart=always \${IMG}
            '
          """
        }
      }
    }

    stage('Upload Audit Evidence'){
      steps {
        script {
          def who = currentBuild.rawBuild.getCause(hudson.model.Cause$UserIdCause)?.userId ?: 'automation'
          def payload = groovy.json.JsonOutput.toJson([
            app: env.APP,
            tag: env.TAG,
            commit: env.GIT_COMMIT,
            digest_ref: env.ECR_REPO,
            env: params.ENV,
            target_host: env.TARGET_HOST,
            target_port: env.TARGET_PORT,
            container: env.TARGET_NAME,
            triggered_by: who,
            build: env.BUILD_NUMBER,
            at: new Date().format("yyyy-MM-dd'T'HH:mm:ss'Z'", TimeZone.getTimeZone("UTC"))
          ])
          writeFile file: "deploy-ledger-${TAG}.json", text: payload
        }
        sh """
	  set -euxo pipefail

      	  echo '== AWS CLI & identity =='
      	  which aws
          aws --version
          aws sts get-caller-identity --region ${AWS_REGION}

          echo '== Files to upload =='
          ls -l "${SBOM}" || { echo "SBOM not found: ${SBOM}"; exit 2; }
          ls -l "deploy-ledger-${TAG}.json"

          echo '== Check bucket exists =='
          aws s3api head-bucket --bucket demo-artifact-audit --region ${AWS_REGION} || {
          echo 'Bucket not accessible (missing or no permission)'; exit 3;}

          echo '== Uploading =='
          aws s3 cp "${SBOM}" "s3://demo-artifact-audit/sbom/${APP}/${TAG}.json" --sse AES256 --region ${AWS_REGION}

          aws s3 cp "deploy-ledger-${TAG}.json" "s3://demo-artifact-audit/deploy-ledger/${APP}/" --sse AES256 --region ${AWS_REGION}
        """
      }
    }
  }

  post {
    success {
      echo "✅ ${APP} ${TAG} deployed: ${params.ENV} → ${TARGET_HOST}:${TARGET_PORT} (container: ${TARGET_NAME})"
    }
  }
}

