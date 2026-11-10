import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { POST } from '@/app/api/admin/models/[id]/activate/route';
import { apiAdministrator } from '@/lib/http/admin';
import { activateModelConfig } from '@/lib/services/models';
import { AdminInputError } from '@/lib/services/admin';

vi.mock('@/lib/http/admin', () => ({ apiAdministrator: vi.fn() }));
vi.mock('@/lib/services/models', () => ({ activateModelConfig: vi.fn() }));

const context = { params: Promise.resolve({ id: '00000000-0000-4000-8000-0000000000aa' }) };
const request = (input?: unknown) => new NextRequest('https://console.example.test/api/admin/models/model/activate', {
  method: 'POST',
  ...(input === undefined ? {} : { body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiAdministrator).mockResolvedValue({ id: 'admin' } as Awaited<ReturnType<typeof apiAdministrator>>);
  vi.mocked(activateModelConfig).mockResolvedValue({ activated: true, reembed: false, jobId: null });
});

describe('model activation audience', () => {
  it('requires the administrator gate', async () => {
    vi.mocked(apiAdministrator).mockResolvedValue(new NextResponse(null, { status: 401 }));
    expect((await POST(request({ audience: 'plan' }), context)).status).toBe(401);
    expect(activateModelConfig).not.toHaveBeenCalled();
  });

  it('passes the selected audience and keeps bodyless activations compatible', async () => {
    await POST(request({ audience: 'plan' }), context);
    expect(activateModelConfig).toHaveBeenLastCalledWith('admin', '00000000-0000-4000-8000-0000000000aa', 'plan');
    await POST(request(), context);
    expect(activateModelConfig).toHaveBeenLastCalledWith('admin', '00000000-0000-4000-8000-0000000000aa', 'free');
  });

  it('rejects unsupported audiences and Plan activation for other model kinds', async () => {
    expect((await POST(request({ audience: 'paid' }), context)).status).toBe(422);
    expect(activateModelConfig).not.toHaveBeenCalled();
    vi.mocked(activateModelConfig).mockRejectedValue(new AdminInputError('audience'));
    expect((await POST(request({ audience: 'plan' }), context)).status).toBe(422);
  });
});
