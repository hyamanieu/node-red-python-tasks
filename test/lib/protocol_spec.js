// Test suite for lib/protocol.js

const Protocol = require('../../lib/protocol');
const chai = require('chai');
const expect = chai.expect;

describe('Protocol', function() {
    let protocol;

    beforeEach(function() {
        protocol = new Protocol();
    });

    describe('createRequest', function() {
        it('should create a request with id and op', function() {
            const message = protocol.createRequest('call', { function_id: 'test' });
            const parsed = JSON.parse(message.trim());
            
            expect(parsed).to.have.property('id');
            expect(parsed).to.have.property('op', 'call');
            expect(parsed).to.have.property('function_id', 'test');
            expect(message).to.match(/\n$/);
        });

        it('should generate unique IDs for each request', function() {
            const message1 = protocol.createRequest('call', {});
            const message2 = protocol.createRequest('call', {});
            
            const parsed1 = JSON.parse(message1.trim());
            const parsed2 = JSON.parse(message2.trim());
            
            expect(parsed1.id).to.not.equal(parsed2.id);
        });
    });

    describe('formatMessage', function() {
        it('should format a message with newline', function() {
            const formatted = protocol.formatMessage({ id: '123', op: 'ping' });
            expect(formatted).to.equal('{"id":"123","op":"ping"}\n');
        });
    });

    describe('processIncoming', function() {
        it('should parse valid JSON messages', function() {
            const messages = protocol.processIncoming('{"id":"1","op":"ready"}\n');
            expect(messages).to.have.lengthOf(1);
            expect(messages[0]).to.deep.equal({ id: '1', op: 'ready' });
        });

        it('should handle multiple messages', function() {
            const messages = protocol.processIncoming('{"id":"1"}\n{"id":"2"}\n');
            expect(messages).to.have.lengthOf(2);
        });

        it('should handle partial messages in buffer', function() {
            // First chunk
            protocol.processIncoming('{"id":"1"');
            // Second chunk completes the message
            const messages = protocol.processIncoming('}\n');
            expect(messages).to.have.lengthOf(1);
            expect(messages[0]).to.deep.equal({ id: '1' });
        });

        it('should ignore empty lines', function() {
            const messages = protocol.processIncoming('\n\n{"id":"1"}\n\n');
            expect(messages).to.have.lengthOf(1);
        });

        it('should handle malformed JSON without crashing', function() {
            // Should not throw
            const messages = protocol.processIncoming('not json\n');
            expect(messages).to.have.lengthOf(0);
        });
    });

    describe('waitForResponse', function() {
        it('should resolve promise on successful response', function(done) {
            const requestId = 'test-123';
            
            // Send a message that looks like a response
            const message = `{"id":"${requestId}","ok":true,"result":{"value":42}}\n`;
            
            // Create promise first
            protocol.waitForResponse(requestId, 100).then((response) => {
                expect(response).to.deep.equal({
                    id: requestId,
                    ok: true,
                    result: { value: 42 }
                });
                done();
            }).catch(done);

            // Process the incoming message
            protocol.processIncoming(message);
        });

        it('should reject promise on error response', function(done) {
            const requestId = 'test-456';
            const errorInfo = {
                type: 'ValueError',
                message: 'test error',
                traceback: 'trace...'
            };
            
            const message = `{"id":"${requestId}","ok":false,"error":${JSON.stringify(errorInfo)}}\n`;
            
            protocol.waitForResponse(requestId, 100).then(() => {
                done(new Error('Should have rejected'));
            }).catch((err) => {
                expect(err).to.be.instanceOf(Error);
                expect(err.message).to.equal('test error');
                expect(err.type).to.equal('ValueError');
                expect(err.traceback).to.equal('trace...');
                done();
            });

            // Process the incoming message
            protocol.processIncoming(message);
        });

        it('should timeout if no response received', function(done) {
            const requestId = 'test-789';
            
            protocol.waitForResponse(requestId, 50).then(() => {
                done(new Error('Should have timed out'));
            }).catch((err) => {
                expect(err.message).to.match(/timeout/);
                done();
            });
        });
    });

    describe('handleMessage', function() {
        it('should emit ready event', function(done) {
            protocol.addListener((event, message) => {
                if (event === 'ready') {
                    expect(message).to.deep.equal({ op: 'ready', protocol: 1, python: '3.12.3' });
                    done();
                }
            });

            protocol.processIncoming('{"op":"ready","protocol":1,"python":"3.12.3"}\n');
        });

        it('should handle unknown message types without crashing', function() {
            // Should not throw
            protocol.processIncoming('{"op":"unknown"}\n');
        });
    });

    describe('clearAll', function() {
        it('should clear all pending requests', function(done) {
            const requestId = 'test-clear';
            
            protocol.waitForResponse(requestId, 100).catch((err) => {
                expect(err.message).to.match(/closed/);
                done();
            });

            protocol.clearAll();
        });
    });

    describe('listeners', function() {
        it('should add and remove listeners', function() {
            const listener1 = () => {};
            const listener2 = () => {};
            
            protocol.addListener(listener1);
            protocol.addListener(listener2);
            
            expect(protocol.listeners).to.have.lengthOf(2);
            
            protocol.removeListener(listener1);
            expect(protocol.listeners).to.have.lengthOf(1);
        });
    });
});
