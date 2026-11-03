import { render, screen, waitFor } from '@testing-library/react';

import HomePage from '../../src/app/page';

const fetchMock = jest.fn<typeof fetch>();

describe('HomePage', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    } as Response);
    global.fetch = fetchMock;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('identifies the app and confirms the frontend is running', async () => {
    render(<HomePage />);

    expect(
      screen.getByRole('heading', {
        name: 'Smart Fuel Stations Monitoring & Management System',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Frontend is running.')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Backend status: Connected')).toBeInTheDocument();
    });
  });

  it('checks the API health endpoint using the configured URL', async () => {
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('Backend status: Connected')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/api/health');
  });
});
