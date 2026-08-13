var sinon         = require('sinon'),
    should        = require('chai').should(),
    flow          = require('../../helpers/flow'),
    defaults      = require('../../helpers/defaults'),
    config        = require('config'),
    url           = require('url'),
    ObjectId      = require('mongoose').Types.ObjectId;

module.exports = function() {
  describe('User Registration', function() {
    var libraryUser, sampleCourse;

    before(function(done) {
      libraryUser = new User({
        fullname: 'test trinket library user',
        username: 'testlibraryuser',
        email:'bliggedy@bloo.poo',
        password:'flim-flam-bim-bam'
      });

      libraryUser.save(function(err, user) {
        if (err) return done(err);

        sampleCourse = new Course({
          name:        'the sampler',
          description: 'a sample course for you!',
          _owner:      user,
          ownerSlug:   user.username
        });

        sampleCourse.save(function(err, course){
          if (err) return done(err);

          done();
        });
      });
    });

    after(function(done) {
      libraryUser.remove(function() {
        sampleCourse.remove(done);  
      });
    });

    describe('When I enter valid registration data', function(){
      before(function(done) {
        flow.switchUser('user');
        // make sure a user does not already exist
        User.findByLogin(defaults.user.email, function(err, doc) {
          should.not.exist(doc);
          done();
        });
      });

      it('should create a new user account', function(done) {
        // register the user
        flow.register(function(err, response) {
          User.findByLogin(defaults.user.email, function(err, doc) {
            should.exist(doc);
            done();
          });
        });
      });

      it('should redirect to the welcome page', function() {
        flow.wasOk.should.be.true;
        flow.lastResponse.statusCode.should.eql(302);
        flow.lastResponse.redirect.should.be.true;
        flow.lastRedirect.pathname.should.eql('/welcome');
      });

      it('should include a link to the default course on the welcome page', function(done) {
        flow.welcome(function() {
          flow.lastResponse.text.should.contain('/' + libraryUser.username + '/courses/' + sampleCourse.slug + '/copy');
          done();
        });
      });

      it('should allow the sample course to be copied', function(done) {
        flow.post('/' + libraryUser.username + '/courses/' + sampleCourse.slug + '/copy')
          .set('referer', '/welcome')
          .end(function(err, response) {
            should.not.exist(err);
            response.statusCode.should.eql(302);
            url.parse(response.headers.location).pathname.should.eql('/u/' + defaults.user.username + '/classes/' + sampleCourse.slug);
            done();
          });
      });

      it('should allow the sample course to be loaded', function(done) {
        flow.viewCourse(defaults.user.username, sampleCourse.slug, function() {
          flow.lastResponse.statusCode.should.eql(200);
          done();
        });
      });
    });

    describe('When I enter duplicate registration data', function() {
      before(function(done) {
        flow.switchUser('');
        flow.register({ username : defaults.user.username.toUpperCase() }, function(err, response) {
          done();
        });
      });

      it('should redirect me to the signup page', function() {
        flow.wasOk.should.be.true;
        flow.lastResponse.statusCode.should.eql(302);
        flow.lastResponse.redirect.should.be.true;
        flow.lastRedirect.pathname.should.eql('/signup');
      });
    });

    describe('When I enter invalid registration data', function() {
      before(function() {
        flow.switchUser('');
      });

      before(function(done) {
        flow.register({email:'invalid'}, function(err, response) {
          done();
        });
      });

      it('should redirect me to the signup page', function() {
        flow.wasOk.should.be.true;
        flow.lastResponse.statusCode.should.eql(302);
        flow.lastResponse.redirect.should.be.true;
        flow.lastRedirect.pathname.should.eql('/signup');
      });

      it('should not create a new user account', function(done) {
        User.findByLogin('invalid', function(err, doc) {
          should.not.exist(doc);
          done();
        });
      });

      it('should not let me visit the welcome page', function(done) {
        flow.welcome(function() {
          flow.wasOk.should.be.true;
          flow.lastResponse.statusCode.should.eql(302);
          flow.lastRedirect.pathname.should.eql('/login');
          done();
        });
      });
    });

    describe('When self-service is disabled', function() {
      var config = require('config');

      before(function() {
        config.features.selfService = false;
        flow.switchUser('');
      });

      after(function() {
        config.features.selfService = true;
      });

      it('should 403 the create endpoint and create no account', function(done) {
        flow.post('/api/users')
          .send({ email: 'lockout@example.com', password: 'sekret1' })
          .end(function(err, res) {
            res.statusCode.should.eql(403);
            User.findByLogin('lockout@example.com', function(err, doc) {
              should.not.exist(doc);
              done();
            });
          });
      });

      it('should redirect GET /signup to /login', function(done) {
        flow.get('/signup').end(function(err, res) {
          res.statusCode.should.eql(302);
          url.parse(res.headers.location).pathname.should.eql('/login');
          done();
        });
      });
    });

    describe('Page rendering (regression: config.viewEngine loader corruption)', function() {
      // config.viewEngine = viewEngine (app.js) stored the live nunjucks env in the
      // config object; node-config's deep-extend then flattened the FileSystemLoader
      // into a plain object mid-render, so every page 500'd with
      // "loader.getSource is not a function". Guard against reintroducing it.
      before(function() { flow.switchUser(''); });

      it('should render GET / with status 200', function(done) {
        flow.get('/').end(function(err, res) {
          res.statusCode.should.eql(200);
          done();
        });
      });

      it('should render GET /login with status 200', function(done) {
        flow.get('/login').end(function(err, res) {
          res.statusCode.should.eql(200);
          done();
        });
      });
    });
  });
}
