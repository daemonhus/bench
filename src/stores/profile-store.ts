import { create } from 'zustand';
import type { ServiceProfile } from '../core/types';
import { EMPTY_SERVICE_PROFILE } from '../core/types';
import { profileApi } from '../core/api';

interface ProfileState {
  profile: ServiceProfile;
  /** True once the profile has been explicitly written at least once.
   *  While false, the backend rejects review-judgment writes with 412. */
  configured: boolean;
  loaded: boolean;
  bannerDismissed: boolean;

  load: () => Promise<void>;
  save: (patch: Partial<ServiceProfile>) => Promise<ServiceProfile>;
  dismissBanner: () => void;
}

export const useProfileStore = create<ProfileState>((set) => ({
  profile: EMPTY_SERVICE_PROFILE,
  configured: true, // optimistic until first load so the banner doesn't flash
  loaded: false,
  bannerDismissed: false,

  load: async () => {
    try {
      const profile = await profileApi.get();
      set({ profile, configured: !!profile.updatedAt, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  save: async (patch: Partial<ServiceProfile>) => {
    const profile = await profileApi.update(patch);
    set({ profile, configured: true });
    return profile;
  },

  dismissBanner: () => set({ bannerDismissed: true }),
}));
