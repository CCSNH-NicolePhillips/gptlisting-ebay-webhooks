import { json } from '../../src/lib/_auth.js';

describe('json helper', () => {
  it('should create JSON response with default 200 status', () => {
    const result = json({ message: 'success' });
    
    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(result.body).toBe('{"message":"success"}');
  });

  it('should create JSON response with custom status code', () => {
    const result = json({ error: 'Not found' }, 404);
    
    expect(result.statusCode).toBe(404);
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(result.body).toBe('{"error":"Not found"}');
  });

  it('should handle complex objects', () => {
    const data = {
      user: { id: 123, name: 'Test User' },
      items: [1, 2, 3],
      nested: { deeply: { nested: true } },
    };
    const result = json(data);
    
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(JSON.stringify(data));
  });

  it('should handle arrays', () => {
    const data = [{ id: 1 }, { id: 2 }];
    const result = json(data);
    
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('[{"id":1},{"id":2}]');
  });

  it('should handle null and undefined', () => {
    const resultNull = json(null);
    const resultUndefined = json(undefined);
    
    expect(resultNull.body).toBe('null');
    expect(resultUndefined.body).toBe(undefined);
  });

  it('should handle strings', () => {
    const result = json('plain string');
    
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('"plain string"');
  });

  it('should handle numbers', () => {
    const result = json(42, 201);
    
    expect(result.statusCode).toBe(201);
    expect(result.body).toBe('42');
  });

  it('should handle booleans', () => {
    const result = json(true);
    
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('true');
  });

  it('should handle common HTTP status codes', () => {
    expect(json({}, 200).statusCode).toBe(200); // OK
    expect(json({}, 201).statusCode).toBe(201); // Created
    expect(json({}, 400).statusCode).toBe(400); // Bad Request
    expect(json({}, 401).statusCode).toBe(401); // Unauthorized
    expect(json({}, 403).statusCode).toBe(403); // Forbidden
    expect(json({}, 404).statusCode).toBe(404); // Not Found
    expect(json({}, 500).statusCode).toBe(500); // Internal Server Error
  });
});
