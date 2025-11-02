pipeline {
  agent any
  options { timestamps() }
  parameters {
    choice(name: 'ENV', choices: ['staging','prod'], description: 'Deploy environment')
    string(name: 'SEMVER', defaultValue: '1.0.0', description: 'Release semver, e.g. 1.0.0')
  }
  environment {
    AWS_REGION  = '<AWS_REGION>' // e.g. us-west-2
    REGISTRY    = '<AWS_ACC_ID>.dkr.ecr.${AWS_REGION}.amazonaws.com'
    ECR_REPO    = '${REGISTRY}/<ECR_REPO>' // e.g. demo-app-service
    APP         = 'demo-app-service'
    TAG         = "${params.SEMVER}+g${GIT_COMMIT.take(7)}"
    REF         = "${ECR_REPO}:${TAG}"
    SBOM        = "sbom-${TAG}.json"
    COSIGN_EXPERIMENTAL = "1"
  }

  stages {
    stage('Checkout'){ steps { checkout scm } }

    stage('Build'){
      steps { sh "docker build --pull -t ${REF} ." }
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

    stage('Generate SBOM'){
      steps {
        sh "syft ${REF} -o cyclonedx-json > ${SBOM}"
        archiveArtifacts artifacts: "${SBOM}", fingerprint: true
      }
    }

    stage('Vulnerability Scan'){
      steps {
        sh "trivy image --exit-code 1 --severity HIGH,CRITICAL ${REF}"
      }
    }

    stage('Sign & Attest'){
      steps {
        withCredentials([file(credentialsId: 'cosign-private-key', variable: 'COSIGN_KEY')]) {
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

    stage('Deploy'){
      steps {
        sshagent(credentials: ['deploy-ssh']) {
          sh """
            DIGEST=\$(crane digest ${REF})
            IMG="${ECR_REPO}@\${DIGEST}"
            cosign verify --key cosign.pub \${IMG}

            TARGET_HOST=\$( [ "${params.ENV}" = "prod" ] && echo "<PROD_HOST>" || echo "<STAGING_HOST>" )

            ssh -o StrictHostKeyChecking=yes ec2-user@\${TARGET_HOST} '
              set -euo pipefail
              aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${REGISTRY}
              docker pull \${IMG}
              docker stop ${APP} || true
              docker rm ${APP} || true
              docker run -d --name ${APP} -p 80:8080 --restart=always \${IMG}
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
            digest_ref: "${env.ECR_REPO}",
            env: params.ENV,
            triggered_by: who,
            build: env.BUILD_NUMBER,
            at: new Date().format("yyyy-MM-dd'T'HH:mm:ss'Z'", TimeZone.getTimeZone("UTC"))
          ])
          writeFile file: "deploy-ledger-${TAG}.json", text: payload
        }
        sh """
          aws s3 cp ${SBOM} s3://demo-artifact-audit/sbom/${APP}/${TAG}.json --sse AES256
          aws s3 cp deploy-ledger-${TAG}.json s3://demo-artifact-audit/deploy-ledger/${APP}/ --sse AES256
        """
      }
    }
  }

  post {
    success { echo "✅ ${APP} ${TAG} deployed to ${params.ENV}" }
  }
}
