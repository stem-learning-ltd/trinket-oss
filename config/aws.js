var AWS      = require('aws-sdk')
    , config = require('config');

var awsConfig = {
  accessKeyId       : config.aws.keyId
  , secretAccessKey : config.aws.key
  , region          : config.aws.region
};

// S3-compatible storage (Tigris on Fly): custom endpoint via the
// AWS_ENDPOINT_URL_S3 env var (custom-environment-variables.yaml).
if (config.has('aws.endpoint') && config.aws.endpoint) {
  awsConfig.endpoint = config.aws.endpoint;
}

AWS.config.update(awsConfig);

module.exports = AWS;
