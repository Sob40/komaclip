Rails.application.routes.draw do
  scope "(:locale)", locale: /en|es/ do
    resource :session
    resource :registration, only: %i[ new create ]
    resources :passwords, param: :token
    resources :clip_templates, only: %i[ create destroy ] do
      post :use, on: :member
    end
    resources :projects, only: %i[ new create show ] do
      post :confirm_material, on: :member

      resources :assets, controller: "project_assets", only: %i[ create show destroy ] do
        resources :panels, only: :create

        member do
          get :download
        end
      end

      resources :panels, only: %i[ show update destroy ] do
        post :duplicate, on: :member
        patch :reorder, on: :collection
      end
      resources :clips, only: %i[ create show destroy ]
    end

    get "app", to: "dashboard#show", as: :dashboard

    root "home#index"
  end

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Render dynamic PWA files from app/views/pwa/* (remember to link manifest in application.html.erb)
  # get "manifest" => "rails/pwa#manifest", as: :pwa_manifest
  # get "service-worker" => "rails/pwa#service_worker", as: :pwa_service_worker
end
