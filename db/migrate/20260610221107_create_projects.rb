class CreateProjects < ActiveRecord::Migration[8.1]
  def change
    create_table :projects do |t|
      t.references :user, null: false, foreign_key: true
      t.string :title, null: false
      t.string :content_locale, null: false, default: "en"
      t.string :status, null: false, default: "draft"
      t.jsonb :metadata, null: false, default: {}

      t.timestamps
    end

    add_index :projects, [ :user_id, :status ]
    add_index :projects, [ :user_id, :updated_at ]
  end
end
