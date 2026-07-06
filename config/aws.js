var AWS      = require('aws-sdk')
    , config = require('config');

var awsConfig = {
  accessKeyId       : config.aws.keyId
  , secretAccessKey : config.aws.key
  , region          : config.aws.region
};

// S3-compatible storage (Tigris on Fly): custom endpoint via aws.endpoint,
// set through the $NODE_CONFIG JSON env var (see fly/README.md).
// NB config@0.4.x has no .has(); plain property access only.
if (config.aws && config.aws.endpoint) {
  awsConfig.endpoint = config.aws.endpoint;
}

AWS.config.update(awsConfig);

module.exports = AWS;
